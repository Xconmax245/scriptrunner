import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { createServiceClient } from "@/lib/supabase/server";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

const execAsync = promisify(exec);

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
        .select("id, hostname, display_name, enrollment_status")
        .eq("id", device_id)
        .maybeSingle();
      targetDevice = data;
    }

    if (!targetDevice) {
      const { data } = await supabase
        .from("devices")
        .select("id, hostname, display_name, enrollment_status")
        .eq("enrollment_status", "enrolled")
        .limit(1)
        .maybeSingle();
      targetDevice = data;
    }

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    // Execute PowerShell command reliably via temporary .ps1 script file
    const tempFile = path.join(os.tmpdir(), `sr_term_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.ps1`);
    try {
      await fs.writeFile(tempFile, trimmedCommand, "utf8");
      const psCommand = `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`;
      
      const result = await execAsync(psCommand, {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
      });

      stdout = result.stdout || "";
      stderr = result.stderr || "";
      exitCode = 0;
    } catch (err: any) {
      stdout = err.stdout || "";
      stderr = err.stderr || err.message || "Command execution failed";
      exitCode = typeof err.code === "number" ? err.code : 1;
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }

    const durationMs = Date.now() - startTime;

    // Record in audit log & jobs history asynchronously so history is preserved
    try {
      if (targetDevice?.id) {
        const scriptHash = crypto.createHash("sha256").update(trimmedCommand, "utf8").digest("hex");
        const { data: job } = await supabase
          .from("jobs")
          .insert({
            organization_id: organizationId,
            device_id: targetDevice.id,
            created_by: "00000000-0000-0000-0000-000000000001",
            script_content: trimmedCommand,
            script_type: "powershell",
            script_hash: scriptHash,
            description: `Terminal: ${trimmedCommand.slice(0, 60)}`,
            state: exitCode === 0 ? "succeeded" : "failed",
            timeout_seconds: 30,
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            started_at: new Date(startTime).toISOString(),
            completed_at: new Date().toISOString(),
          })
          .select("id")
          .maybeSingle();

        if (job?.id) {
          await supabase.from("job_attempts").insert({
            job_id: job.id,
            device_id: targetDevice.id,
            attempt_number: 1,
            state: exitCode === 0 ? "succeeded" : "failed",
            exit_code: exitCode,
            stdout_text: stdout,
            stderr_text: stderr,
            started_at: new Date(startTime).toISOString(),
            completed_at: new Date().toISOString(),
          });
        }
      }
    } catch (auditErr) {
      console.warn("Failed to record terminal job in database:", auditErr);
    }

    return NextResponse.json({
      success: true,
      command: trimmedCommand,
      stdout,
      stderr,
      exitCode,
      durationMs,
      target: targetDevice?.hostname || targetDevice?.display_name || "TARGET-HOST",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Terminal execution failed" },
      { status: 500 }
    );
  }
}
