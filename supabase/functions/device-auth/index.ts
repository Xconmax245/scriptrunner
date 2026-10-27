// Edge Function: device-auth
// Called by the Windows agent to authenticate using its per-device API key.
// Returns a short-lived device JWT on success.
// No user auth required (verify_jwt = false in config)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { create } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  device_id: z.string().uuid(),
  api_key: z.string().min(64).max(128),
  agent_version: z.string().max(40).optional(),
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

  // Rate limit hint: enforce at the Supabase API gateway level
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

  const { device_id, api_key, agent_version } = parsed.data;

  // Validate API key prefix (first 8 hex chars of the key)
  const keyPrefix = api_key.substring(0, 8);
  const keyHash = await sha256hex(api_key);

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Look up device by ID and prefix to avoid full-table hash scan
  const { data: device, error: deviceErr } = await supabaseAdmin
    .from("devices")
    .select("id, organization_id, api_key_hash, api_key_prefix, enrollment_status")
    .eq("id", device_id)
    .eq("api_key_prefix", keyPrefix)
    .single();

  if (deviceErr || !device) {
    // Constant-time response to prevent enumeration
    await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Verify hash matches
  if (device.api_key_hash !== keyHash) {
    await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Check enrollment status
  if (device.enrollment_status === "revoked") {
    return new Response(JSON.stringify({ error: "Device revoked" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (device.enrollment_status !== "enrolled") {
    return new Response(JSON.stringify({ error: "Device not enrolled" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Update heartbeat
  await supabaseAdmin.rpc("device_heartbeat", {
    p_device_id: device_id,
    p_agent_version: agent_version ?? "",
  });

  // Issue a short-lived device JWT (1 hour)
  const jwtSecret = Deno.env.get("DEVICE_JWT_SECRET");
  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(jwtSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const now = Math.floor(Date.now() / 1000);
  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      sub: device_id,
      device_id,
      organization_id: device.organization_id,
      role: "device_agent",
      iat: now,
      exp: now + 3600, // 1 hour
    },
    key
  );

  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
