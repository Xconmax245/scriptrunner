/**
 * POST /api/jobs
 * Submits a script execution job using the service role key.
 * Works in login-wall-free mode — no user session required.
 *
 * The service role key is NEVER exposed to the browser bundle.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, httpErrorResponse, requireAdmin } from "@/lib/auth/authorization";
import { z } from "zod";
import crypto from "crypto";

const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const uuidSchema = z.string().regex(uuidRegex, "Invalid UUID");

const schema = z.object({
  organization_id: uuidSchema.optional(),
  device_id: uuidSchema,
  script_content: z.string().min(1).max(131072),
  script_type: z.enum(["powershell"]).default("powershell"),
  description: z.string().max(500).optional(),
  change_ticket: z.string().max(100).optional(),
  timeout_seconds: z.number().int().min(1).max(86400).default(300),
  expires_in_seconds: z.number().int().min(60).max(604800).default(86400),
  idempotency_key: z.string().max(128).optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.format() },
      { status: 422 }
    );
  }

  const {
    device_id,
    script_content,
    script_type,
    description,
    change_ticket,
    timeout_seconds,
    expires_in_seconds,
    idempotency_key,
  } = parsed.data;

  const organization_id =
    parsed.data.organization_id ||
    process.env.NEXT_PUBLIC_DEFAULT_ORG_ID ||
    "00000000-0000-0000-0000-000000000001";

  // Command execution is never available anonymously: require an authenticated
  // owner/administrator of the target organization.
  let admin;
  try {
    admin = await requireAdmin(organization_id);
  } catch (error) {
    return httpErrorResponse(error);
  }

  const supabase = createServiceClient();

  // Enforce script size limit from org settings
  const { data: settings } = await supabase
    .from("organization_settings")
    .select("max_script_bytes")
    .eq("organization_id", organization_id)
    .single();

  const maxBytes = settings?.max_script_bytes ?? 131072;
  const scriptBytes = Buffer.byteLength(script_content, "utf8");
  if (scriptBytes > maxBytes) {
    return NextResponse.json(
      { error: `Script too large: ${scriptBytes} bytes (max ${maxBytes})` },
      { status: 413 }
    );
  }

  // Verify device is enrolled in this org and not revoked
  const { data: device } = await supabase
    .from("devices")
    .select("id, enrollment_status, organization_id")
    .eq("id", device_id)
    .eq("organization_id", organization_id)
    .single();

  if (!device || device.enrollment_status !== "enrolled") {
    return NextResponse.json(
      { error: "Device not found or not enrolled in this organization" },
      { status: 404 }
    );
  }

  const scriptHash = crypto
    .createHash("sha256")
    .update(script_content, "utf8")
    .digest("hex");
  const expiresAt = new Date(
    Date.now() + expires_in_seconds * 1000
  ).toISOString();

  const adminUserId = admin.userId;

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      organization_id,
      device_id,
      created_by: adminUserId,
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
      return NextResponse.json(
        { error: "Duplicate idempotency key for this organization" },
        { status: 409 }
      );
    }
    console.error("Job insert error:", jobErr);
    return NextResponse.json({ error: "Failed to create job: " + jobErr.message }, { status: 500 });
  }

  // Audit event
  await supabase.from("audit_events").insert({
    organization_id,
    actor_type: "user",
    actor_id: adminUserId,
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
    ip_address: clientIp(req),
  });

  return NextResponse.json(
    {
      job_id: job!.id,
      state: job!.state,
      created_at: job!.created_at,
      expires_at: job!.expires_at,
      script_hash: job!.script_hash,
    },
    { status: 201 }
  );
}
