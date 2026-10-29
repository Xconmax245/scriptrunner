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
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, httpErrorResponse, requireAdmin, requireUser } from "@/lib/auth/authorization";
import { terminalCloseDeviceSessions } from "@/lib/terminal/terminalStore";

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
      return NextResponse.json({ error: "Invalid request payload" }, { status: 422 });
    }

    // Authenticate before the device lookup
    await requireUser();

    const service = createServiceClient();
    const { data: device, error: fetchErr } = await service
      .from("devices")
      .select("id, organization_id, enrollment_status, display_name, hostname, metadata")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    const admin = await requireAdmin(device.organization_id);
    const action = body.data.action;
    const reason = body.data.reason?.trim() || null;
    const now = new Date().toISOString();

    // 1. Attempt database RPC if deployed
    let rpcSuccess = false;
    try {
      const { data: result, error: rpcError } = await service.rpc("device_set_lifecycle_state", {
        p_device_id: id,
        p_org_id: device.organization_id,
        p_actor: admin.userId,
        p_action: action,
        p_reason: reason,
      });

      if (!rpcError && result === "ok") {
        rpcSuccess = true;
      } else if (result && result !== "ok") {
        const statusCode =
          result === "forbidden" ? 403 : result === "not_found" ? 404 : 409;
        return NextResponse.json(
          { error: `Device state change rejected (${result})` },
          { status: statusCode }
        );
      }
    } catch {
      rpcSuccess = false;
    }

    // 2. Direct database update fallback if RPC is not present
    if (!rpcSuccess) {
      const meta = (device.metadata && typeof device.metadata === "object") ? { ...(device.metadata as Record<string, unknown>) } : {};

      const updates: Record<string, unknown> = {
        updated_at: now,
      };

      if (action === "authorize") {
        updates.enrollment_status = "enrolled";
        updates.enrolled_at = now;
        updates.revoked_at = null;
        meta.authorized_at = now;
        meta.authorized_by = admin.userId;
        meta.suspension_reason = null;
        meta.revocation_reason = null;
      } else if (action === "suspend") {
        updates.enrollment_status = "suspended";
        meta.is_suspended = true;
        meta.suspended_at = now;
        meta.suspended_by = admin.userId;
        meta.suspension_reason = reason || "Suspended by administrator";
      } else if (action === "resume") {
        updates.enrollment_status = "enrolled";
        updates.revoked_at = null;
        meta.is_suspended = false;
        meta.resumed_at = now;
        meta.resumed_by = admin.userId;
        meta.suspension_reason = null;
        meta.revocation_reason = null;
      } else if (action === "revoke") {
        updates.enrollment_status = "revoked";
        updates.revoked_at = now;
        // Invalidate API key so agent can no longer authenticate
        updates.api_key_hash = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
        updates.api_key_prefix = "revoked_";
        meta.is_suspended = false;
        meta.revoked_at = now;
        meta.revoked_by = admin.userId;
        meta.revocation_reason = reason || "Revoked by administrator";
      }

      updates.metadata = meta;

      let { error: updateErr } = await service
        .from("devices")
        .update(updates)
        .eq("id", id);

      if (updateErr && String(updateErr.message).includes("suspended")) {
        // If DB enum does not have 'suspended', persist suspension in metadata
        delete updates.enrollment_status;
        const fallbackRes = await service
          .from("devices")
          .update(updates)
          .eq("id", id);
        updateErr = fallbackRes.error;
      }

      if (updateErr) {
        console.error("Direct device update failed:", updateErr);
        return NextResponse.json({ error: updateErr.message || "Failed to update device state" }, { status: 500 });
      }

      // Close live terminal sessions in terminalStore and Supabase
      if (action === "suspend" || action === "revoke") {
        const closeMsg = action === "revoke" ? "Device access revoked" : "Device suspended";
        await terminalCloseDeviceSessions(id, closeMsg);

        // Cancel any pending or in-flight jobs for this device
        try {
          await service
            .from("jobs")
            .update({
              state: "cancelled",
              completed_at: now,
              error_summary: closeMsg,
              updated_at: now,
            })
            .eq("device_id", id)
            .in("state", ["queued", "waiting_for_device", "claimed"]);
        } catch (jobErr) {
          console.warn("Could not cancel in-flight jobs for device:", jobErr);
        }

        // Also close terminal_sessions table if present
        try {
          await service
            .from("terminal_sessions")
            .update({
              status: action === "revoke" ? "revoked" : "closed",
              closed_at: now,
              close_reason: closeMsg,
            })
            .eq("device_id", id)
            .in("status", ["pending", "active"]);
        } catch {}
      }
    }

    // 3. Fetch current device state using existing columns only
    const { data: updated } = await service
      .from("devices")
      .select("id, display_name, hostname, operating_system, agent_version, enrollment_status, last_seen_at, revoked_at, metadata")
      .eq("id", id)
      .single();

    // 4. Record audit event for traceability
    try {
      await service.from("audit_events").insert({
        organization_id: device.organization_id,
        actor_type: "user",
        actor_id: admin.userId,
        action: `device.${action}`,
        target_type: "device",
        target_id: id,
        metadata: {
          action,
          reason: reason || null,
          previous_status: device.enrollment_status,
          device_name: device.display_name || device.hostname,
          actor_user_id: admin.userId,
        },
        ip_address: clientIp(req),
        timestamp: now,
      });
    } catch (auditErr) {
      console.warn("Failed to record audit event:", auditErr);
    }

    return NextResponse.json({ success: true, device: updated });
  } catch (error) {
    console.error("Device status update error:", error);
    return httpErrorResponse(error);
  }
}
