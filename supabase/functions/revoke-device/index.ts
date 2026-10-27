// Edge Function: revoke-device
// Revokes a device, preventing it from claiming future jobs.
// verify_jwt = true
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  device_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

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
    return new Response(JSON.stringify({ error: "Validation failed" }), {
      status: 422,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { device_id, organization_id, reason } = parsed.data;

  // Only administrators and owners can revoke devices
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "administrator"].includes(member.role)) {
    return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Revoke the device
  const { data: device, error: updateErr } = await supabaseAdmin
    .from("devices")
    .update({
      enrollment_status: "revoked",
      revoked_at: new Date().toISOString(),
      // Invalidate the API key by changing the hash to an impossible value
      api_key_hash: "revoked",
      api_key_prefix: "00000000",
    })
    .eq("id", device_id)
    .eq("organization_id", organization_id)
    .neq("enrollment_status", "revoked")
    .select("id, display_name")
    .single();

  if (updateErr || !device) {
    return new Response(JSON.stringify({ error: "Device not found or already revoked" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Cancel any queued/pending jobs for this device
  await supabaseAdmin
    .from("jobs")
    .update({
      state: "cancelled",
      completed_at: new Date().toISOString(),
      error_summary: "Device revoked by administrator",
    })
    .eq("device_id", device_id)
    .in("state", ["queued", "waiting_for_device", "claimed"]);

  // Audit log
  await supabaseAdmin.from("audit_events").insert({
    organization_id,
    actor_type: "user",
    actor_id: user.id,
    action: "device.revoked",
    target_type: "device",
    target_id: device_id,
    metadata: { display_name: device.display_name, reason: reason ?? null },
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return new Response(
    JSON.stringify({ success: true, device_id, message: "Device revoked and pending jobs cancelled." }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
