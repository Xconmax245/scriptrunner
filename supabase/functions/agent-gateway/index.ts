// Edge Function: agent-gateway
//
// Single authenticated transport endpoint for the Windows agent. It replaces the
// agent's direct PostgREST calls (which could not work: the device JWT is signed
// with the platform's device secret, not the Supabase project JWT secret).
//
// Authentication: `Authorization: Bearer <device JWT>` issued by device-auth.
// Every request re-checks the device's lifecycle state in the database, so a
// suspension or revocation takes effect on the agent's next call (sub-second
// while a terminal session is open, because the agent long-polls).
//
// The agent never holds a service-role credential. The service role is used only
// inside this function and every query is scoped to the authenticated device.
//
// Terminal transport:
//   terminal_claim  – pick up a session an administrator opened for this device
//   terminal_poll   – long-poll (up to 20s) for commands; delivers immediately
//   terminal_output – push ordered output chunks (bounded by the database)
//   terminal_command_result / terminal_end
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const POLL_WINDOW_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const PACKAGE_BUCKET = Deno.env.get("PACKAGE_BUCKET") ?? "software-packages";
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders },
  });
}

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function asIsoDate(value: unknown, fallback = new Date()): string {
  if (typeof value !== "string") return fallback.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

async function verifyDeviceJwt(
  token: string
): Promise<{ deviceId: string; organizationId: string } | null> {
  const secret = Deno.env.get("DEVICE_JWT_SECRET");
  if (!secret) return null;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const payload = (await verify(token, key)) as Record<string, unknown>;
    const deviceId = asUuid(payload.device_id);
    const organizationId = asUuid(payload.organization_id);
    if (!deviceId || !organizationId || payload.role !== "device_agent") return null;
    return { deviceId, organizationId };
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) return json({ error: "Missing device token" }, 401);

  const identity = await verifyDeviceJwt(token);
  if (!identity) return json({ error: "Invalid or expired device token" }, 401);

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    return json({ error: "Request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = asString(body.action, 40);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Re-check lifecycle state on every call: immediate revocation enforcement.
  const { data: device, error: deviceErr } = await admin
    .from("devices")
    .select("id, organization_id, enrollment_status, hostname")
    .eq("id", identity.deviceId)
    .maybeSingle();

  if (deviceErr || !device) return json({ error: "Device not found" }, 404);
  if (device.organization_id !== identity.organizationId) {
    return json({ error: "Device organization mismatch" }, 403);
  }
  if (device.enrollment_status !== "enrolled") {
    return json(
      { error: "Device is not authorized to receive commands", code: "device_not_authorized", enrollment_status: device.enrollment_status },
      403
    );
  }

  const deviceId = identity.deviceId;

  switch (action) {
    // ---------------------------------------------------------
    // Telemetry
    // ---------------------------------------------------------
    case "heartbeat": {
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
      if (error) return json({ error: error.message }, 500);
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        enrollment_status: row?.enrollment_status ?? "enrolled",
        pending_jobs_count: row?.pending_jobs ?? 0,
        pending_deployments: row?.pending_deployments ?? 0,
        offline_after_seconds: row?.offline_after_seconds ?? 300,
        server_time: row?.server_time ?? new Date().toISOString(),
        settings: {
          metrics_interval_seconds: row?.metrics_interval_seconds ?? 60,
          inventory_interval_seconds: row?.inventory_interval_seconds ?? 21600,
          software_scan_interval_seconds: row?.software_scan_interval_seconds ?? 21600,
          event_scan_interval_seconds: row?.event_scan_interval_seconds ?? 300,
          allow_custom_powershell_monitors: Boolean(row?.allow_custom_powershell_monitors),
          allow_security_event_collection: Boolean(row?.allow_security_event_collection),
          allow_service_recovery: Boolean(row?.allow_service_recovery),
          service_recovery_cooldown_seconds: row?.service_recovery_cooldown_seconds ?? 600,
          max_event_bytes_per_scan: row?.max_event_bytes_per_scan ?? 1048576,
        },
      });
    }

    // ---------------------------------------------------------
    // RMM: inventory, telemetry, monitors
    // ---------------------------------------------------------
    case "agent_config": {
      const { data, error } = await admin.rpc("rmm_get_agent_config", {
        p_device_id: deviceId,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? {});
    }

    case "ingest_inventory": {
      const hardware = asObject(body.hardware);
      const os = asObject(body.os);
      const network = asObject(body.network);
      if (!hardware || !os || !network) {
        return json({ error: "Inventory payload must contain hardware, os and network objects" }, 422);
      }
      const { data, error } = await admin.rpc("rmm_ingest_inventory", {
        p_device_id: deviceId,
        p_hardware: hardware,
        p_os: os,
        p_network: network,
        p_data_quality: asObject(body.data_quality) ?? { warnings: asArray(body.data_quality, 50) },
        p_collected_at: asIsoDate(body.collected_at),
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { ok: true });
    }

    case "ingest_metrics": {
      const samples = asArray(body.samples, 500);
      if (samples.length === 0) return json({ inserted: 0 });
      const { data, error } = await admin.rpc("rmm_ingest_metrics", {
        p_device_id: deviceId,
        p_samples: samples,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { inserted: samples.length });
    }

    case "ingest_software": {
      const applications = asArray(body.applications, 3000);
      const { data, error } = await admin.rpc("rmm_ingest_software", {
        p_device_id: deviceId,
        p_apps: applications,
        p_collected_at: asIsoDate(body.collected_at),
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { ok: true });
    }

    case "ingest_events": {
      const events = asArray(body.events, 200);
      if (events.length === 0) return json({ inserted: 0 });
      const { data, error } = await admin.rpc("rmm_ingest_events", {
        p_device_id: deviceId,
        p_events: events,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { inserted: 0 });
    }

    case "monitor_result": {
      const monitorId = asUuid(body.monitor_id);
      const status = asString(body.status, 20);
      const allowedStatuses = ["ok", "warning", "critical", "unknown", "error"];
      if (!monitorId || !allowedStatuses.includes(status)) {
        return json({ error: "Invalid monitor result" }, 422);
      }

      const value = typeof body.value === "number" && Number.isFinite(body.value)
        ? body.value
        : null;

      const { data, error } = await admin.rpc("rmm_report_monitor_result", {
        p_device_id: deviceId,
        p_monitor_id: monitorId,
        p_status: status,
        p_value: value,
        p_message: asString(body.message, 2000) || null,
        p_details: asObject(body.details) ?? {},
        p_duration_ms: Math.max(0, Math.min(Number(body.duration_ms) || 0, 600_000)),
        p_error: asString(body.error, 2000) || null,
        p_observed_at: asIsoDate(body.observed_at),
        p_recovery_performed: Boolean(body.recovery_performed),
        p_recovery_note: asString(body.recovery_note, 2000) || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { ok: true });
    }

    // ---------------------------------------------------------
    // Software deployment
    // ---------------------------------------------------------
    case "claim_deployment": {
      const { data, error } = await admin.rpc("rmm_claim_deployment", {
        p_device_id: deviceId,
      });
      if (error) return json({ error: error.message }, 500);
      const job = Array.isArray(data) ? data[0] : data;
      if (!job) return json({ job: null });

      // Short-lived signed URL generated server-side. The agent never receives
      // storage credentials and cannot enumerate the bucket.
      const { data: signed, error: signErr } = await admin.storage
        .from(PACKAGE_BUCKET)
        .createSignedUrl(job.storage_path, 900);

      if (signErr) {
        console.error("package signing failed", signErr.message);
      }

      return json({
        job: {
          ...job,
          download_url: signed?.signedUrl ?? null,
        },
      });
    }

    case "deployment_update": {
      const jobId = asUuid(body.job_id);
      const state = asString(body.state, 30);
      const allowedStates = [
        "downloading", "validating", "installing", "verifying", "succeeded",
        "failed", "cancelled", "expired", "reboot_required", "blocked",
      ];
      if (!jobId || !allowedStates.includes(state)) {
        return json({ error: "Invalid deployment update" }, 422);
      }

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
      if (error) return json({ error: error.message }, 500);
      return json(data ?? { ok: true });
    }

    // ---------------------------------------------------------
    // Queued script jobs (existing feature, now over the gateway)
    // ---------------------------------------------------------
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
      if (!jobId || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
        return json({ error: "Invalid job/attempt" }, 422);
      }

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
      const allowed = ["succeeded", "failed", "timed_out", "cancelled", "outcome_unknown"];
      if (!jobId || !allowed.includes(outcome)) return json({ error: "Invalid completion" }, 422);

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

    // ---------------------------------------------------------
    // Remote terminal
    // ---------------------------------------------------------
    case "terminal_claim": {
      const { data, error } = await admin.rpc("terminal_agent_claim", {
        p_device_id: deviceId,
        p_agent_instance: asString(body.agent_instance, 64),
      });
      if (error) return json({ error: error.message }, 500);
      const session = Array.isArray(data) ? data[0] : data;
      if (!session?.session_id) return json({ session: null });
      return json({
        session: {
          session_id: session.session_id,
          expires_at: session.expires_at,
          last_output_sequence: Number(session.last_output_sequence ?? 0),
          hostname: session.hostname ?? device.hostname ?? "",
        },
      });
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
      if (items.length === 0 || items.length > 200) {
        return json({ error: "Invalid output batch" }, 422);
      }

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
      if (!sessionId || !Number.isFinite(sequence)) {
        return json({ error: "Invalid command result" }, 422);
      }
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
      // Cheap status check used while a long-running command executes, so a
      // revocation/closure stops the command instead of waiting for it to finish.
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
      return json({ error: "Unknown action" }, 400);
  }
});
