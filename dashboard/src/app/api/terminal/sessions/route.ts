/**
 * /api/terminal/sessions
 *
 * POST  – open a remote terminal session on a target device
 * GET   – list recent sessions for a device (audit/history)
 *
 * Only an authenticated owner/administrator of the device's organization can
 * do either. The agent is not contacted directly: it picks the session up over
 * its authenticated long-poll channel.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, httpErrorResponse, requireAdmin, requireUser } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  device_id: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 422 });
    }

    // Authenticate before the device lookup (no existence oracle for
    // unauthenticated callers).
    await requireUser();

    const service = createServiceClient();
    const { data: device } = await service
      .from("devices")
      .select("id, organization_id, display_name, hostname, enrollment_status")
      .eq("id", parsed.data.device_id)
      .maybeSingle();

    if (!device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    const admin = await requireAdmin(device.organization_id);

    if (device.enrollment_status !== "enrolled") {
      return NextResponse.json(
        {
          error:
            device.enrollment_status === "revoked"
              ? "This device has been revoked and cannot accept sessions."
              : device.enrollment_status === "suspended"
                ? "This device is suspended and cannot accept sessions."
                : "This device is not authorized yet. An administrator must authorize it first.",
        },
        { status: 409 }
      );
    }

    const { data, error } = await service.rpc("terminal_create_session", {
      p_device_id: parsed.data.device_id,
      p_actor: admin.userId,
      p_client_ip: clientIp(req),
    });

    if (error) {
      console.error("terminal_create_session failed:", error.message);
      const notAuthorized = /device_not_authorized/.test(error.message);
      const forbidden = /forbidden/.test(error.message);
      return NextResponse.json(
        {
          error: notAuthorized
            ? "Device is not authorized for sessions"
            : forbidden
              ? "Not authorized"
              : "Failed to open session",
        },
        { status: notAuthorized ? 409 : forbidden ? 403 : 500 }
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.session_id) {
      return NextResponse.json({ error: "Failed to open session" }, { status: 500 });
    }

    return NextResponse.json(
      {
        session: {
          id: row.session_id,
          expires_at: row.expires_at,
          hostname: row.hostname ?? device.hostname,
          device_id: device.id,
          device_name: device.display_name,
          created_by: admin.userId,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return httpErrorResponse(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const deviceId = new URL(req.url).searchParams.get("device_id");
    if (!deviceId) {
      return NextResponse.json({ error: "device_id is required" }, { status: 422 });
    }

    await requireUser();

    const service = createServiceClient();
    const { data: device } = await service
      .from("devices")
      .select("id, organization_id")
      .eq("id", deviceId)
      .maybeSingle();

    if (!device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    const admin = await requireAdmin(device.organization_id);

    const { data: sessions } = await service
      .from("terminal_sessions")
      .select(
        "id, status, close_reason, hostname_snapshot, created_at, activated_at, closed_at, last_activity_at, expires_at"
      )
      .eq("device_id", deviceId)
      .eq("organization_id", admin.organizationId)
      .order("created_at", { ascending: false })
      .limit(25);

    return NextResponse.json({ sessions: sessions ?? [] });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
