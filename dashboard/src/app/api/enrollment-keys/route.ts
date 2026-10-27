/**
 * /api/enrollment-keys
 *
 * Organization-level enrollment policy for zero-touch installations.
 * The plaintext key is returned exactly once (on creation); only its SHA-256
 * hash is stored, so it can never be retrieved again.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, httpErrorResponse, requireAdmin } from "@/lib/auth/authorization";

const createSchema = z.object({
  organization_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  expires_in_hours: z.number().int().min(1).max(24 * 365).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const organizationId = new URL(req.url).searchParams.get("organization_id") ?? undefined;
    const admin = await requireAdmin(organizationId);
    const service = createServiceClient();

    const { data, error } = await service
      .from("organization_enrollment_keys")
      .select("id, name, key_prefix, created_at, expires_at, revoked_at, last_used_at, use_count")
      .eq("organization_id", admin.organizationId)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("organization_enrollment_keys table warning:", error.message);
      return NextResponse.json({
        organization_id: admin.organizationId,
        keys: [],
        auto_authorize_devices: false,
        terminal_inactivity_secs: 900,
        terminal_max_secs: 3600,
      });
    }

    const { data: settings } = await service
      .from("organization_settings")
      .select("auto_authorize_devices, terminal_inactivity_secs, terminal_max_secs")
      .eq("organization_id", admin.organizationId)
      .maybeSingle();

    return NextResponse.json({
      organization_id: admin.organizationId,
      keys: data ?? [],
      auto_authorize_devices: settings?.auto_authorize_devices ?? false,
      terminal_inactivity_secs: settings?.terminal_inactivity_secs ?? 900,
      terminal_max_secs: settings?.terminal_max_secs ?? 3600,
    });
  } catch (error) {
    return httpErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 422 });
    }

    const admin = await requireAdmin(parsed.data.organization_id);
    const service = createServiceClient();

    // Cryptographically random 32-byte key, 64 hex characters.
    const key = crypto.randomBytes(32).toString("hex");
    const keyHash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
    const keyPrefix = key.substring(0, 8);

    const expiresAt = parsed.data.expires_in_hours
      ? new Date(Date.now() + parsed.data.expires_in_hours * 3600 * 1000).toISOString()
      : null;

    const { data: created, error } = await service
      .from("organization_enrollment_keys")
      .insert({
        organization_id: admin.organizationId,
        name: parsed.data.name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        created_by: admin.userId,
        expires_at: expiresAt,
      })
      .select("id, name, key_prefix, created_at, expires_at")
      .single();

    if (error || !created) {
      console.error("Failed to create enrollment key:", error?.message);
      return NextResponse.json({ error: "Failed to create enrollment key" }, { status: 500 });
    }

    await service.from("audit_events").insert({
      organization_id: admin.organizationId,
      actor_type: "user",
      actor_id: admin.userId,
      action: "enrollment_key.created",
      target_type: "enrollment_key",
      target_id: created.id,
      metadata: { name: created.name, key_prefix: keyPrefix, expires_at: expiresAt },
      ip_address: clientIp(req),
    });

    return NextResponse.json(
      {
        key: {
          id: created.id,
          name: created.name,
          key_prefix: keyPrefix,
          created_at: created.created_at,
          expires_at: created.expires_at,
        },
        // Shown once. Never stored in plaintext and never logged.
        enrollment_key: key,
        install_command:
          `powershell -ExecutionPolicy Bypass -File .\\install-service.ps1 ` +
          `-SupabaseUrl "<your-supabase-url>" -EnrollmentKey "${key}"`,
      },
      { status: 201 }
    );
  } catch (error) {
    return httpErrorResponse(error);
  }
}
