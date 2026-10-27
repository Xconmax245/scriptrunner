// Edge Function: create-invitation
// Creates a single-use, expiring enrollment invitation
// Requires: authenticated admin/owner user
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  organization_id: z.string().uuid(),
  display_name: z.string().min(1).max(120),
  expires_in_hours: z.number().int().min(1).max(72).default(24),
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

  // Use service role for privileged operations
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Verify caller identity using their JWT
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
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
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

  const { organization_id, display_name, expires_in_hours } = parsed.data;

  // Check user is admin/owner of this organization
  const { data: member, error: memberErr } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .single();

  if (memberErr || !member || !["owner", "administrator"].includes(member.role)) {
    return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Generate cryptographically random 32-byte token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // 64 hex chars

  const tokenHash = await sha256hex(token);
  const tokenPrefix = token.substring(0, 8);

  const expiresAt = new Date(Date.now() + expires_in_hours * 3600 * 1000).toISOString();

  // Create a pending device placeholder
  const { data: device, error: deviceErr } = await supabaseAdmin
    .from("devices")
    .insert({
      organization_id,
      display_name,
      enrollment_status: "pending",
      api_key_hash: "pending", // replaced at enrollment redemption
      api_key_prefix: "00000000",
    })
    .select("id")
    .single();

  if (deviceErr || !device) {
    console.error("Device insert error:", deviceErr);
    return new Response(JSON.stringify({ error: "Failed to create device record" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { error: invErr } = await supabaseAdmin
    .from("enrollment_invitations")
    .insert({
      organization_id,
      created_by: user.id,
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      display_name,
      expires_at: expiresAt,
    });

  if (invErr) {
    // Rollback device creation
    await supabaseAdmin.from("devices").delete().eq("id", device.id);
    console.error("Invitation insert error:", invErr);
    return new Response(JSON.stringify({ error: "Failed to create invitation" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Audit log
  await supabaseAdmin.from("audit_events").insert({
    organization_id,
    actor_type: "user",
    actor_id: user.id,
    action: "enrollment_invitation.created",
    target_type: "enrollment_invitation",
    target_id: null,
    metadata: { display_name, expires_at: expiresAt, token_prefix: tokenPrefix },
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  // Return the token ONCE – it is never stored in plaintext
  return new Response(
    JSON.stringify({
      token,          // caller must store this securely; not retrievable again
      token_prefix: tokenPrefix,
      device_id: device.id,
      expires_at: expiresAt,
      enrollment_command: `ScriptRunner-Agent enroll --token "${token}" --org "${organization_id}" --device "${device.id}"`,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
