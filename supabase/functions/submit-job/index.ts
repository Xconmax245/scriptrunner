// Edge Function: submit-job
// Validates admin session, creates job atomically with audit event.
// verify_jwt = true
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  organization_id: z.string().uuid(),
  device_id: z.string().uuid(),
  script_content: z.string().min(1).max(131072),
  script_type: z.enum(["powershell"]).default("powershell"),
  description: z.string().max(500).optional(),
  change_ticket: z.string().max(100).optional(),
  timeout_seconds: z.number().int().min(1).max(86400).default(300),
  expires_in_seconds: z.number().int().min(60).max(604800).default(86400),
  idempotency_key: z.string().max(128).optional(),
});

async function sha256hex(input: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Validation failed", details: parsed.error.format() }), {
      status: 422,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const {
    organization_id, device_id, script_content, script_type,
    description, change_ticket, timeout_seconds, expires_in_seconds,
    idempotency_key,
  } = parsed.data;

  // Check membership and role
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .single();

  if (!member) {
    return new Response(JSON.stringify({ error: "Forbidden: not a member of this organization" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Check organization settings for operator permission
  const { data: settings } = await supabaseAdmin
    .from("organization_settings")
    .select("operators_can_submit, max_script_bytes")
    .eq("organization_id", organization_id)
    .single();

  const allowedRoles = ["owner", "administrator"];
  if (settings?.operators_can_submit) allowedRoles.push("operator");

  if (!allowedRoles.includes(member.role)) {
    return new Response(JSON.stringify({ error: "Forbidden: role cannot submit jobs" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Enforce script size limit
  const maxBytes = settings?.max_script_bytes ?? 131072;
  const scriptBytes = new TextEncoder().encode(script_content).length;
  if (scriptBytes > maxBytes) {
    return new Response(JSON.stringify({ error: `Script too large: ${scriptBytes} bytes (max ${maxBytes})` }), {
      status: 413,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Verify device is enrolled in this org and not revoked
  const { data: device } = await supabaseAdmin
    .from("devices")
    .select("id, enrollment_status, organization_id")
    .eq("id", device_id)
    .eq("organization_id", organization_id)
    .single();

  if (!device || device.enrollment_status !== "enrolled") {
    return new Response(JSON.stringify({ error: "Device not found or not enrolled" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const scriptHash = await sha256hex(script_content);
  const expiresAt = new Date(Date.now() + expires_in_seconds * 1000).toISOString();

  // Create job
  const { data: job, error: jobErr } = await supabaseAdmin
    .from("jobs")
    .insert({
      organization_id,
      device_id,
      created_by: user.id,
      script_content,
      script_type,
      script_hash: scriptHash,
      description,
      change_ticket,
      state: "queued",
      timeout_seconds,
      expires_at: expiresAt,
      idempotency_key,
    })
    .select("id, state, created_at, expires_at, script_hash")
    .single();

  if (jobErr) {
    if (jobErr.code === "23505") {
      // Idempotency key conflict
      return new Response(JSON.stringify({ error: "Duplicate idempotency key for this organization" }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    console.error("Job insert error:", jobErr);
    return new Response(JSON.stringify({ error: "Failed to create job" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Audit event
  await supabaseAdmin.from("audit_events").insert({
    organization_id,
    actor_type: "user",
    actor_id: user.id,
    action: "job.submitted",
    target_type: "job",
    target_id: job!.id,
    metadata: {
      device_id,
      script_hash: scriptHash,
      script_type,
      timeout_seconds,
      expires_at: expiresAt,
      change_ticket: change_ticket ?? null,
    },
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return new Response(
    JSON.stringify({
      job_id: job!.id,
      state: job!.state,
      created_at: job!.created_at,
      expires_at: job!.expires_at,
      script_hash: job!.script_hash,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
