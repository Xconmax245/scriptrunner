// Edge Function: redeem-invitation
// Called by the Windows agent installer to complete enrollment.
// verify_jwt = false; uses the one-time token for authentication.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  token: z.string().min(64).max(64),
  organization_id: z.string().uuid(),
  device_id: z.string().uuid(),
  hostname: z.string().max(253),
  operating_system: z.string().max(100),
  agent_version: z.string().max(40),
  display_name: z.string().min(1).max(120),
});

async function sha256hex(input: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate a new per-device API key (64 hex chars = 256 bits)
function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
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

  const { token, organization_id, device_id, hostname, operating_system, agent_version, display_name } = parsed.data;
  const tokenHash = await sha256hex(token);

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Generate per-device API key
  const apiKey = generateApiKey();
  const apiKeyHash = await sha256hex(apiKey);
  const apiKeyPrefix = apiKey.substring(0, 8);

  // Update device API key before redemption (in case of partial failure)
  await supabaseAdmin
    .from("devices")
    .update({ api_key_hash: apiKeyHash, api_key_prefix: apiKeyPrefix })
    .eq("id", device_id)
    .eq("organization_id", organization_id)
    .eq("enrollment_status", "pending");

  // Atomically redeem invitation and activate device
  const { data: result, error: rpcErr } = await supabaseAdmin.rpc("redeem_enrollment_invitation", {
    p_token_hash: tokenHash,
    p_org_id: organization_id,
    p_device_id: device_id,
    p_hostname: hostname,
    p_os: operating_system,
    p_agent_version: agent_version,
    p_display_name: display_name,
  });

  if (rpcErr) {
    console.error("Redemption RPC error:", rpcErr);
    return new Response(JSON.stringify({ error: "Enrollment failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const resultStr = result as string;

  if (resultStr === "not_found") {
    return new Response(JSON.stringify({ error: "Invalid enrollment token" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (resultStr === "expired") {
    return new Response(JSON.stringify({ error: "Enrollment token has expired" }), {
      status: 410,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (resultStr === "already_redeemed") {
    return new Response(JSON.stringify({ error: "Enrollment token already used" }), {
      status: 409,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (resultStr !== "ok") {
    return new Response(JSON.stringify({ error: "Enrollment error: " + resultStr }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Audit log
  await supabaseAdmin.from("audit_events").insert({
    organization_id,
    actor_type: "device",
    actor_id: device_id,
    action: "device.enrolled",
    target_type: "device",
    target_id: device_id,
    metadata: { hostname, operating_system, agent_version },
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  // Return the API key ONCE — it is never retrievable again
  return new Response(
    JSON.stringify({
      api_key: apiKey,   // Store this securely in Windows credential store / protected config file
      device_id,
      organization_id,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
