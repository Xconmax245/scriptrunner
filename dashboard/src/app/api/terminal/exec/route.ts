import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeCommandOnDevice } from "@/lib/terminal/terminalStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { command, device_id } = body;

    if (!command || typeof command !== "string" || !command.trim()) {
      return NextResponse.json({ error: "Command is required" }, { status: 400 });
    }

    const trimmedCommand = command.trim();
    const organizationId = process.env.DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";
    const supabase = createServiceClient();

    // Fetch device info if device_id provided, otherwise get first enrolled device
    let targetDevice: any = null;
    if (device_id) {
      const { data } = await supabase
        .from("devices")
        .select("id, organization_id, hostname, display_name, enrollment_status")
        .eq("id", device_id)
        .maybeSingle();
      targetDevice = data;
    }

    if (!targetDevice) {
      const { data } = await supabase
        .from("devices")
        .select("id, organization_id, hostname, display_name, enrollment_status")
        .eq("enrollment_status", "enrolled")
        .order("last_seen_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      targetDevice = data;
    }

    if (!targetDevice) {
      return NextResponse.json(
        { error: "No enrolled Windows devices available to execute commands" },
        { status: 404 }
      );
    }

    if (targetDevice.enrollment_status !== "enrolled") {
      return NextResponse.json(
        {
          error: `Target device ${targetDevice.hostname || targetDevice.id} is not enrolled (status: ${targetDevice.enrollment_status})`,
        },
        { status: 403 }
      );
    }

    // Execute directly on the remote Windows agent (NYXPC)
    const result = await executeCommandOnDevice({
      deviceId: targetDevice.id,
      organizationId: targetDevice.organization_id || organizationId,
      command: trimmedCommand,
      timeoutSeconds: 30,
    });

    return NextResponse.json({
      success: result.success,
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      target: result.target,
      source: result.source,
      fallbackReason: result.fallbackReason,
      timestamp: result.timestamp,
    });
  } catch (error: any) {
    console.error("[api/terminal/exec] Execution error:", error);
    return NextResponse.json(
      { error: error.message || "Terminal execution failed" },
      { status: 500 }
    );
  }
}
