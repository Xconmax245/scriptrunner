/**
 * POST /api/devices/[id]/status
 * Authorize, suspend, resume or revoke a device.
 *
 * Requires an authenticated owner/administrator of the device's organization.
 * The database RPC closes live terminal sessions and cancels queued jobs when a
 * device is suspended or revoked.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, httpErrorResponse, requireAdmin, requireUser } from "@/lib/auth/authorization";

const schema = z.object({
  action: z.enum(["authorize", "suspend", "resume", "revoke"]),
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 422 });
    }

    // Authenticate before the device lookup (no existence oracle for
    // unauthenticated callers).
    await requireUser();

    const service = createServiceClient();
    const { data: device } = await service
      .from("devices")
      .select("id, organization_id, enrollment_status")
      .eq("id", id)
      .maybeSingle();

    if (!device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    const admin = await requireAdmin(device.organization_id);

    const { data: result, error } = await service.rpc("device_set_lifecycle_state", {
      p_device_id: id,
      p_org_id: device.organization_id,
      p_actor: admin.userId,
      p_action: body.data.action,
      p_reason: body.data.reason ?? null,
    });

    if (error) {
      console.error("device_set_lifecycle_state failed:", error.message);
      return NextResponse.json({ error: "Failed to update device state" }, { status: 500 });
    }

    if (result !== "ok") {
      const statusCode =
        result === "forbidden" ? 403 : result === "not_found" ? 404 : 409;
      return NextResponse.json(
        { error: `Device state change rejected (${result})` },
        { status: statusCode }
      );
    }

    const { data: updated } = await service
      .from("devices")
      .select(
        "id, display_name, hostname, enrollment_status, status_reason, authorized_at, suspended_at, revoked_at, last_seen_at"
      )
      .eq("id", id)
      .single();

    // Audit is written inside the RPC. Record the API origin for traceability.
    await service.from("audit_events").insert({
      organization_id: device.organization_id,
      actor_type: "system",
      actor_id: null,
      action: "device.lifecycle_api_called",
      target_type: "device",
      target_id: id,
      metadata: {
        action: body.data.action,
        previous_status: device.enrollment_status,
        actor_user_id: admin.userId,
      },
      ip_address: clientIp(req),
    });

    return NextResponse.json({ success: true, device: updated });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
