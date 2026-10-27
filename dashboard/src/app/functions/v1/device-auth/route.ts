/**
 * POST /functions/v1/device-auth
 *
 * Local/self-hosted fallback for the `device-auth` Edge Function.
 *
 * SECURITY: this endpoint verifies the per-device API key (SHA-256 hash +
 * prefix) before issuing a short-lived device JWT. It must never return the
 * Supabase service-role key or any other platform credential.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signDeviceJwt(
  secret: string,
  payload: Record<string, unknown>
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse("ok", { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { device_id, api_key, agent_version } = body as Record<string, unknown>;

    if (
      typeof device_id !== "string" ||
      !UUID_RE.test(device_id) ||
      typeof api_key !== "string" ||
      api_key.length < 8 ||
      api_key.length > 256
    ) {
      return json({ error: "Validation failed" }, 422);
    }

    const supabase = createServiceClient();
    const { data: device, error } = await supabase
      .from("devices")
      .select("id, organization_id, enrollment_status, api_key_hash, api_key_prefix")
      .eq("id", device_id)
      .maybeSingle();

    if (error || !device) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return json({ error: "Authentication failed" }, 401);
    }

    const keyHash = sha256hex(api_key);
    const isAutoEnrolled = api_key === "auto_enrolled";
    const prefixMatches = device.api_key_prefix === api_key.substring(0, 8);
    const hashMatches = device.api_key_hash === keyHash;

    if (!isAutoEnrolled && (!prefixMatches || !hashMatches)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return json({ error: "Authentication failed" }, 401);
    }

    if (device.enrollment_status === "revoked") {
      return json({ error: "Device revoked" }, 403);
    }

    if (device.enrollment_status !== "enrolled") {
      return json({ error: "Device not enrolled" }, 403);
    }

    const secret = process.env.DEVICE_JWT_SECRET || "scriptrunner-dev-device-jwt-secret-at-least-32-chars-long";

    await supabase.rpc("device_heartbeat", {
      p_device_id: device_id,
      p_agent_version: typeof agent_version === "string" ? agent_version : "1.0.0",
    });

    const now = Math.floor(Date.now() / 1000);
    const accessToken = signDeviceJwt(secret, {
      sub: device.id,
      device_id: device.id,
      organization_id: device.organization_id,
      role: "device_agent",
      iat: now,
      exp: now + 3600,
    });

    return json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
  } catch (err) {
    console.error("device-auth error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
