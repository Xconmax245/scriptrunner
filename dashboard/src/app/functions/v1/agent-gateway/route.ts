import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { saveRmmData, buildSafeDeviceMetadata } from "@/lib/rmm/rmmStore";
import {
  claimNextDeployment,
  updateDeploymentProgress,
  getPendingDeploymentsCount,
  DeploymentState,
} from "@/lib/rmm/deploymentStore";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_BUCKET = process.env.PACKAGE_BUCKET || "software-packages";
const POLL_WINDOW_MS = 15_000;
const POLL_INTERVAL_MS = 300;

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

function verifyDeviceJwt(token: string): { deviceId: string; organizationId: string } | null {
  const secret = process.env.DEVICE_JWT_SECRET || "scriptrunner-dev-device-jwt-secret-at-least-32-chars-long";
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${bodyB64}`)
    .digest("base64url");

  if (sigB64 !== expectedSig) return null;

  try {
    const payload = JSON.parse(base64urlDecode(bodyB64));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    const deviceId = payload.device_id || payload.sub;
    const organizationId = payload.organization_id;
    if (!deviceId || !organizationId || payload.role !== "device_agent") return null;
    return { deviceId, organizationId };
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders });
}

function asString(val: unknown, max: number): string {
  return typeof val === "string" ? val.slice(0, max) : "";
}

function asUuid(val: unknown): string | null {
  return typeof val === "string" && UUID_RE.test(val) ? val : null;
}

function asObject(val: unknown): Record<string, unknown> | null {
  return val && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function asArray(val: unknown, max: number): unknown[] {
  return Array.isArray(val) ? val.slice(0, max) : [];
}

function asIsoDate(val: unknown, fallback = new Date()): string {
  if (typeof val !== "string") return fallback.toISOString();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function OPTIONS() {
  return new NextResponse("ok", { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return json({ error: "Missing device token" }, 401);
    }

    const identity = verifyDeviceJwt(token);
    if (!identity) {
      return json({ error: "Invalid or expired device token" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = asString(body.action, 40);
    const admin = createServiceClient();

    // Verify device lifecycle
    const { data: device, error: deviceErr } = await admin
      .from("devices")
      .select("id, organization_id, enrollment_status, hostname, operating_system, agent_version")
      .eq("id", identity.deviceId)
      .maybeSingle();

    if (deviceErr || !device) {
      return json({ error: "Device not found" }, 404);
    }

    if (device.organization_id !== identity.organizationId) {
      return json({ error: "Device organization mismatch" }, 403);
    }

    if (device.enrollment_status !== "enrolled") {
      return json(
        {
          error: "Device is not authorized to receive commands",
          code: "device_not_authorized",
          enrollment_status: device.enrollment_status,
        },
        403
      );
    }

    const deviceId = identity.deviceId;
    // Log incoming gateway action for visibility
    // console.log(`[agent-gateway] action=${action} device=${deviceId}`);

    switch (action) {
      case "heartbeat": {
        let row: any = null;
        try {
          const { data, error } = await admin.rpc("rmm_heartbeat", {
            p_device_id: deviceId,
            p_hostname: asString(body.hostname, 253),
            p_os: asString(body.operating_system, 100),
            p_agent_version: asString(body.agent_version, 40),
            p_service_status: asString(body.service_status, 40),
            p_is_elevated: Boolean(body.is_elevated),
            p_execution_account: asString(body.execution_account, 120),
            p_connection_failures: Math.max(0, Math.min(Number(body.connection_failures) || 0, 1_000_000)),
            p_reconnect_attempts: Math.max(0, Math.min(Number(body.reconnect_attempts) || 0, 1_000_000)),
            p_restart_required: Boolean(body.restart_required),
          });
          if (!error && data) {
            row = Array.isArray(data) ? data[0] : data;
          }
        } catch {}

        try {
          await saveRmmData(deviceId, {
            service_status: asString(body.service_status, 40) || "running",
            is_elevated: Boolean(body.is_elevated),
            execution_account: asString(body.execution_account, 120),
          });

          const { data: currentDev } = await admin.from("devices").select("metadata").eq("id", deviceId).single();
          const safeMeta = buildSafeDeviceMetadata(currentDev?.metadata as any, {
            service_status: asString(body.service_status, 40) || "running",
            is_elevated: Boolean(body.is_elevated),
            execution_account: asString(body.execution_account, 120),
          });

          await admin
            .from("devices")
            .update({
              last_seen_at: new Date().toISOString(),
              hostname: asString(body.hostname, 253) || device.hostname,
              operating_system: asString(body.operating_system, 100) || device.operating_system,
              agent_version: asString(body.agent_version, 40) || device.agent_version,
              metadata: safeMeta,
            })
            .eq("id", deviceId);
        } catch (e) {
          console.error("Heartbeat update failed:", e);
        }

        let pendingDeployments = row?.pending_deployments ?? 0;
        try {
          const localPending = await getPendingDeploymentsCount(deviceId);
          pendingDeployments = Math.max(pendingDeployments, localPending);
        } catch {}

        return json({
          enrollment_status: row?.enrollment_status ?? "enrolled",
          pending_jobs_count: row?.pending_jobs ?? 0,
          pending_deployments: pendingDeployments,
          offline_after_seconds: row?.offline_after_seconds ?? 300,
          server_time: row?.server_time ?? new Date().toISOString(),
          settings: {
            metrics_interval_seconds: 15,
            inventory_interval_seconds: 60,
            software_scan_interval_seconds: 120,
            event_scan_interval_seconds: 30,
            allow_custom_powershell_monitors: Boolean(row?.allow_custom_powershell_monitors),
            allow_security_event_collection: Boolean(row?.allow_security_event_collection),
            allow_service_recovery: Boolean(row?.allow_service_recovery),
            service_recovery_cooldown_seconds: row?.service_recovery_cooldown_seconds ?? 600,
            max_event_bytes_per_scan: row?.max_event_bytes_per_scan ?? 1048576,
          },
        });
      }

      case "agent_config": {
        try {
          const { data, error } = await admin.rpc("rmm_get_agent_config", {
            p_device_id: deviceId,
          });
          if (!error && data) return json(data);
        } catch {}
        return json({
          monitors: [],
          settings: {
            metrics_interval_seconds: 15,
            inventory_interval_seconds: 60,
            software_scan_interval_seconds: 120,
            event_scan_interval_seconds: 30,
          },
        });
      }

      case "ingest_inventory": {
        const hardware = asObject(body.hardware);
        const os = asObject(body.os);
        const network = asObject(body.network);
        if (!hardware || !os || !network) {
          return json({ error: "Missing inventory parts" }, 422);
        }
        try {
          await admin.rpc("rmm_ingest_inventory", {
            p_device_id: deviceId,
            p_hardware: hardware,
            p_os: os,
            p_network: network,
            p_data_quality: asObject(body.data_quality) ?? { warnings: asArray(body.data_quality, 50) },
            p_collected_at: asIsoDate(body.collected_at),
          });
        } catch {}

        try {
          await saveRmmData(deviceId, {
            inventory: {
              hardware: hardware as any,
              os: os as any,
              network: network as any,
              collected_at: asIsoDate(body.collected_at),
              data_quality: asArray(body.data_quality, 50),
            },
          });

          const { data: currentDev } = await admin.from("devices").select("metadata").eq("id", deviceId).single();
          const safeMeta = buildSafeDeviceMetadata(currentDev?.metadata as any, {
            inventory: { hardware: hardware as any, os: os as any },
          });
          await admin.from("devices").update({ metadata: safeMeta }).eq("id", deviceId);
        } catch (e) {
          console.error("Failed to save inventory:", e);
        }

        return json({ ok: true, snapshot_created: true });
      }

      case "ingest_metrics": {
        const samples = asArray(body.samples, 500);
        if (samples.length === 0) return json({ inserted: 0 });
        try {
          await admin.rpc("rmm_ingest_metrics", {
            p_device_id: deviceId,
            p_samples: samples,
          });
        } catch {}

        try {
          await saveRmmData(deviceId, {
            metrics: samples as any,
          });

          const { data: currentDev } = await admin.from("devices").select("metadata").eq("id", deviceId).single();
          const safeMeta = buildSafeDeviceMetadata(currentDev?.metadata as any, {
            metrics: samples as any,
          });
          await admin.from("devices").update({ metadata: safeMeta }).eq("id", deviceId);
        } catch (e) {
          console.error("Failed to save metrics:", e);
        }

        return json({ inserted: samples.length });
      }

      case "ingest_software": {
        const applications = asArray(body.applications, 3000);
        try {
          await admin.rpc("rmm_ingest_software", {
            p_device_id: deviceId,
            p_apps: applications,
            p_collected_at: asIsoDate(body.collected_at),
          });
        } catch {}

        try {
          await saveRmmData(deviceId, {
            software: applications as any,
            software_count: applications.length,
            software_collected_at: asIsoDate(body.collected_at),
          });

          const { data: currentDev } = await admin.from("devices").select("metadata").eq("id", deviceId).single();
          const safeMeta = buildSafeDeviceMetadata(currentDev?.metadata as any, {
            software_count: applications.length,
          });
          await admin.from("devices").update({ metadata: safeMeta }).eq("id", deviceId);
        } catch (e) {
          console.error("Failed to save software:", e);
        }

        return json({ ok: true, total: applications.length, added: applications.length });
      }

      case "ingest_events": {
        const events = asArray(body.events, 200);
        if (events.length === 0) return json({ inserted: 0 });
        try {
          await admin.rpc("rmm_ingest_events", {
            p_device_id: deviceId,
            p_events: events,
          });
        } catch {}

        try {
          await saveRmmData(deviceId, {
            events: events as any,
          });
        } catch (e) {
          console.error("Failed to save events:", e);
        }

        return json({ inserted: events.length });
      }

      case "monitor_result": {
        const monitorId = asUuid(body.monitor_id);
        const status = asString(body.status, 20);
        if (!monitorId) return json({ error: "Invalid monitor ID" }, 422);
        try {
          const { data, error } = await admin.rpc("rmm_report_monitor_result", {
            p_device_id: deviceId,
            p_monitor_id: monitorId,
            p_status: status,
            p_value: typeof body.value === "number" ? body.value : null,
            p_message: asString(body.message, 2000) || null,
            p_details: asObject(body.details) ?? {},
            p_duration_ms: Math.max(0, Math.min(Number(body.duration_ms) || 0, 600_000)),
            p_error: asString(body.error, 2000) || null,
            p_observed_at: asIsoDate(body.observed_at),
            p_recovery_performed: Boolean(body.recovery_performed),
            p_recovery_note: asString(body.recovery_note, 2000) || null,
          });
          if (!error) return json(data ?? { ok: true });
        } catch {}
        return json({ ok: true });
      }

      case "claim_deployment": {
        // 1. Try local deployment store
        try {
          const localJob = await claimNextDeployment(deviceId, "http://localhost:3000");
          if (localJob) {
            return json({ job: localJob });
          }
        } catch (err) {
          console.error("Local claim_deployment error:", err);
        }

        // 2. Fallback to Supabase RPC if exists
        try {
          const { data, error } = await admin.rpc("rmm_claim_deployment", {
            p_device_id: deviceId,
          });
          if (!error) {
            const job = Array.isArray(data) ? data[0] : data;
            if (!job) return json({ job: null });
            const { data: signed } = await admin.storage
              .from(PACKAGE_BUCKET)
              .createSignedUrl(job.storage_path, 900);
            return json({ job: { ...job, download_url: signed?.signedUrl ?? null } });
          }
        } catch {}
        return json({ job: null });
      }

      case "deployment_update": {
        const jobId = asUuid(body.job_id);
        const state = asString(body.state, 30);
        if (!jobId) return json({ error: "Invalid job ID" }, 422);

        // 1. Update local deployment store
        try {
          await updateDeploymentProgress(jobId, {
            state: state as DeploymentState,
            progress: Number.isFinite(Number(body.progress)) ? Number(body.progress) : null,
            exit_code: Number.isFinite(Number(body.exit_code)) ? Number(body.exit_code) : null,
            output: asString(body.output, 65536) || null,
            error: asString(body.error, 2000) || null,
            reboot_required: typeof body.reboot_required === "boolean" ? body.reboot_required : null,
          });
        } catch (err) {
          console.error("Local deployment_update error:", err);
        }

        // 2. Fallback to Supabase RPC if exists
        try {
          const { data, error } = await admin.rpc("rmm_update_deployment", {
            p_device_id: deviceId,
            p_job_id: jobId,
            p_state: state,
            p_progress: Number.isFinite(Number(body.progress)) ? Number(body.progress) : null,
            p_exit_code: Number.isFinite(Number(body.exit_code)) ? Number(body.exit_code) : null,
            p_output: asString(body.output, 65536) || null,
            p_error: asString(body.error, 2000) || null,
            p_reboot_required: typeof body.reboot_required === "boolean" ? body.reboot_required : null,
          });
          if (!error) return json(data ?? { ok: true });
        } catch {}
        return json({ ok: true });
      }

      case "pending_jobs": {
        const { data, error } = await admin
          .from("jobs")
          .select("id, organization_id, device_id, script_type, state, timeout_seconds, expires_at, created_at, not_before")
          .eq("device_id", deviceId)
          .in("state", ["queued", "waiting_for_device"])
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: true })
          .limit(10);
        if (error) return json({ error: error.message }, 500);
        return json({ jobs: data ?? [] });
      }

      case "claim_job": {
        const { data, error } = await admin.rpc("claim_next_job", { p_device_id: deviceId });
        if (error) return json({ error: error.message }, 500);
        const job = Array.isArray(data) ? data[0] : data;
        return json({ job: job ?? null });
      }

      case "mark_running": {
        const jobId = asUuid(body.job_id);
        const attemptNumber = Number(body.attempt_number ?? 1);
        if (!jobId) return json({ error: "Invalid job" }, 422);

        const { data: attempt, error: upsertErr } = await admin
          .from("job_attempts")
          .upsert(
            {
              job_id: jobId,
              device_id: deviceId,
              attempt_number: attemptNumber,
              state: "running",
              agent_execution_id: asString(body.agent_execution_id, 64),
              started_at: new Date().toISOString(),
            },
            { onConflict: "job_id,attempt_number" }
          )
          .select("id")
          .single();

        if (upsertErr || !attempt) return json({ error: "Failed to create attempt" }, 500);

        const { data: ok, error } = await admin.rpc("mark_job_running", {
          p_job_id: jobId,
          p_device_id: deviceId,
          p_attempt_id: attempt.id,
        });
        if (error) return json({ error: error.message }, 500);
        return json({ success: Boolean(ok) });
      }

      case "report_completion": {
        const jobId = asUuid(body.job_id);
        const attemptNumber = Number(body.attempt_number ?? 1);
        const outcome = asString(body.outcome, 30);
        if (!jobId) return json({ error: "Invalid completion" }, 422);

        const { data: attempt } = await admin
          .from("job_attempts")
          .select("id")
          .eq("job_id", jobId)
          .eq("attempt_number", attemptNumber)
          .maybeSingle();

        if (!attempt) return json({ error: "Attempt not found" }, 409);

        const { data: ok, error } = await admin.rpc("complete_job", {
          p_job_id: jobId,
          p_device_id: deviceId,
          p_attempt_id: attempt.id,
          p_outcome: outcome,
          p_exit_code: Number.isFinite(Number(body.exit_code)) ? Number(body.exit_code) : -1,
          p_stdout_text: asString(body.stdout, 65536),
          p_stdout_truncated: Boolean(body.stdout_truncated),
          p_stderr_text: asString(body.stderr, 16384),
          p_stderr_truncated: Boolean(body.stderr_truncated),
          p_error_summary: asString(body.error_summary, 1000) || null,
        });
        if (error) return json({ error: error.message }, 500);
        return json({ success: Boolean(ok) });
      }

      case "ambiguous_jobs": {
        const { data, error } = await admin.rpc("get_ambiguous_jobs", { p_device_id: deviceId });
        if (error) return json({ error: error.message }, 500);
        return json({ jobs: data ?? [] });
      }

      case "terminal_claim": {
        try {
          const { data, error } = await admin.rpc("terminal_agent_claim", {
            p_device_id: deviceId,
            p_agent_instance: asString(body.agent_instance, 64),
          });
          if (!error && data) {
            const session = Array.isArray(data) ? data[0] : data;
            if (session?.session_id) {
              return json({
                session: {
                  session_id: session.session_id,
                  expires_at: session.expires_at,
                  last_output_sequence: Number(session.last_output_sequence ?? 0),
                  hostname: session.hostname ?? device.hostname ?? "",
                },
              });
            }
          }
        } catch {}
        return json({ session: null });
      }

      case "terminal_poll": {
        const sessionId = asUuid(body.session_id);
        if (!sessionId) return json({ error: "Invalid session" }, 422);

        const deadline = Date.now() + POLL_WINDOW_MS;
        let lastStatus = "active";
        let lastReason: string | null = null;

        do {
          const { data, error } = await admin.rpc("terminal_agent_poll", {
            p_session_id: sessionId,
            p_device_id: deviceId,
          });
          if (error) return json({ error: error.message }, 500);

          const rows = (data ?? []) as Array<Record<string, unknown>>;
          const status = String(rows[0]?.session_status ?? "invalid");
          lastStatus = status;
          lastReason = (rows[0]?.close_reason as string | null) ?? null;

          const commands = rows
            .filter((row) => row.command_id)
            .map((row) => ({
              command_id: row.command_id,
              sequence: Number(row.command_sequence),
              command: String(row.command ?? ""),
            }));

          if (commands.length > 0 || !["pending", "active"].includes(status)) {
            return json({
              session_status: status,
              close_reason: lastReason,
              commands,
            });
          }

          await delay(POLL_INTERVAL_MS);
        } while (Date.now() < deadline);

        return json({ session_status: lastStatus, close_reason: lastReason, commands: [] });
      }

      case "terminal_output": {
        const sessionId = asUuid(body.session_id);
        const items = Array.isArray(body.items) ? body.items : [];
        if (!sessionId) return json({ error: "Invalid session" }, 422);

        const normalized = items
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const stream = asString((item as Record<string, unknown>).stream, 10);
            const content = asString((item as Record<string, unknown>).content, 8192);
            return {
              stream: ["stdout", "stderr", "system"].includes(stream) ? stream : "system",
              content,
            };
          })
          .filter((item) => item.content.length > 0);

        if (normalized.length === 0) return json({ session_status: "active", last_output_sequence: 0 });

        const { data, error } = await admin.rpc("terminal_agent_append_output", {
          p_session_id: sessionId,
          p_device_id: deviceId,
          p_items: normalized,
        });
        if (error) return json({ error: error.message }, 500);
        const row = Array.isArray(data) ? data[0] : data;
        return json({
          session_status: row?.session_status ?? "active",
          last_output_sequence: Number(row?.last_output_sequence ?? 0),
        });
      }

      case "terminal_command_result": {
        const sessionId = asUuid(body.session_id);
        const sequence = Number(body.sequence);
        if (!sessionId || !Number.isFinite(sequence)) return json({ error: "Invalid command result" }, 422);

        const { data, error } = await admin.rpc("terminal_agent_command_result", {
          p_session_id: sessionId,
          p_device_id: deviceId,
          p_command_sequence: sequence,
          p_exit_ok: Boolean(body.exit_ok),
          p_error: asString(body.error, 1000) || null,
        });
        if (error) return json({ error: error.message }, 500);
        return json({ success: Boolean(data) });
      }

      case "terminal_state": {
        const sessionId = asUuid(body.session_id);
        if (!sessionId) return json({ error: "Invalid session" }, 422);
        const { data, error } = await admin
          .from("terminal_sessions")
          .select("status, close_reason")
          .eq("id", sessionId)
          .eq("device_id", deviceId)
          .maybeSingle();
        if (error) return json({ error: error.message }, 500);
        return json({
          session_status: data?.status ?? "invalid",
          close_reason: data?.close_reason ?? null,
        });
      }

      case "terminal_end": {
        const sessionId = asUuid(body.session_id);
        if (!sessionId) return json({ error: "Invalid session" }, 422);
        const { data, error } = await admin.rpc("terminal_close_session", {
          p_session_id: sessionId,
          p_actor: null,
          p_reason: asString(body.reason, 500) || "Session ended by agent",
          p_device_id: deviceId,
        });
        if (error) return json({ error: error.message }, 500);
        return json({ result: data });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("agent-gateway error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
