// Edge Function: enroll-device
// Automatic, zero-touch enrollment for the ScriptRunner Windows agent.
//
// The installation presents the organization's enrollment key (delivered to the
// installer by an administrator) plus a self-generated device ID / install ID.
// No per-device invitation token and no manually typed device ID is required.
//
// Security notes:
//  * Only the SHA-256 hash of the enrollment key is stored server-side.
//  * The device API key is generated here, returned exactly once, and only its
//    hash is persisted.
//  * Enrollment does not grant command execution on its own: with the default
//    policy the device lands in `unauthorized` until an administrator approves
//    it. `auto_authorize_devices` is an explicit per-organization policy.
//  * Rate limiting for invalid keys is handled by the edge gateway; this handler
//    adds a constant delay to blunt online guessing.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const schema = z.object({
  enrollment_key: z.string().min(32).max(256),
  // Client-generated, stable for the lifetime of the installation.
  install_id: z.string().uuid(),
  device_id: z.string().uuid(),
  hostname: z.string().min(1).max(253),
  operating_system: z.string().max(100).optional().default(""),
  agent_version: z.string().max(40).optional().default(""),
});

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Validation failed", details: parsed.error.format() }, 422);
  }

  const { enrollment_key, install_id, device_id, hostname, operating_system, agent_version } =
    parsed.data;

  // Device API key: 32 random bytes, returned once, never stored in plaintext.
  const apiKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(apiKeyBytes);
  const apiKey = Array.from(apiKeyBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const apiKeyHash = await sha256hex(apiKey);
  const apiKeyPrefix = apiKey.substring(0, 8);

  const keyHash = await sha256hex(enrollment_key);

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await supabaseAdmin.rpc("enroll_device_with_key", {
    p_key_hash: keyHash,
    p_install_id: install_id,
    p_device_id: device_id,
    p_hostname: hostname,
    p_os: operating_system ?? "",
    p_agent_version: agent_version ?? "",
    p_api_key_hash: apiKeyHash,
    p_api_key_prefix: apiKeyPrefix,
  });

  if (error) {
    console.error("enroll_device_with_key failed:", error.message);
    return json({ error: "Enrollment failed" }, 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const result = row?.result as string | undefined;

  if (result === "invalid_key" || result === "key_revoked" || result === "key_expired") {
    // Constant-ish delay: do not turn this endpoint into an oracle.
    await new Promise((r) => setTimeout(r, 250));
    return json({ error: "Enrollment key is not valid", code: result }, 401);
  }

  if (result === "device_revoked") {
    return json({ error: "This device was revoked by an administrator", code: result }, 409);
  }

  if (result === "device_exists") {
    return json({ error: "Device ID collision; reinstall with a new identity", code: result }, 409);
  }

  if (result !== "ok" || !row?.device_id) {
    return json({ error: "Enrollment failed", code: result ?? "unknown" }, 500);
  }

  return json(
    {
      device_id: row.device_id,
      organization_id: row.organization_id,
      enrollment_status: row.enrollment_status,
      api_key: apiKey,
      api_key_prefix: apiKeyPrefix,
      server_time: new Date().toISOString(),
    },
    201
  );
});
