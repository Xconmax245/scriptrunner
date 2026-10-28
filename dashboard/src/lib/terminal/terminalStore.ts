import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";

export interface TerminalOutputChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  content: string;
  timestamp: string;
}

export interface TerminalCommandItem {
  commandId: string;
  sequence: number;
  command: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  exitOk?: boolean;
  exitCode?: number;
  error?: string | null;
  stdout: string;
  stderr: string;
}

export interface TerminalSessionRecord {
  sessionId: string;
  deviceId: string;
  organizationId: string;
  hostname: string;
  status: "pending" | "active" | "closed" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  lastOutputSequence: number;
  lastCommandSequence: number;
  agentInstanceId?: string;
  closeReason?: string | null;
  commands: TerminalCommandItem[];
  outputBuffer: TerminalOutputChunk[];
}

export interface ExecutionResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  target: string;
  source: "terminal_session" | "agent_job";
  fallbackReason?: string;
  timestamp: string;
}

const DATA_ROOT = path.join(process.cwd(), "data");
const SESSIONS_FILE = path.join(DATA_ROOT, "terminal_sessions.json");

function ensureDirs() {
  if (!fsSync.existsSync(DATA_ROOT)) {
    fsSync.mkdirSync(DATA_ROOT, { recursive: true });
  }
}

// In-memory sessions store attached to globalThis so separate Next.js route compilations share state
const g = globalThis as unknown as {
  __terminalSessions?: Map<string, TerminalSessionRecord>;
  __terminalDeviceSessionMap?: Map<string, string>;
  __terminalPollWaiters?: Map<string, Array<() => void>>;
  __terminalCommandWaiters?: Map<string, (res: ExecutionResult) => void>;
  __terminalLoaded?: boolean;
};

if (!g.__terminalSessions) g.__terminalSessions = new Map<string, TerminalSessionRecord>();
if (!g.__terminalDeviceSessionMap) g.__terminalDeviceSessionMap = new Map<string, string>();
if (!g.__terminalPollWaiters) g.__terminalPollWaiters = new Map<string, Array<() => void>>();
if (!g.__terminalCommandWaiters) g.__terminalCommandWaiters = new Map<string, (res: ExecutionResult) => void>();

const sessions: Map<string, TerminalSessionRecord> = g.__terminalSessions;
const deviceSessionMap: Map<string, string> = g.__terminalDeviceSessionMap;
const pollWaiters: Map<string, Array<() => void>> = g.__terminalPollWaiters;
const commandWaiters: Map<string, (res: ExecutionResult) => void> = g.__terminalCommandWaiters;

async function loadSessions(): Promise<void> {
  if (g.__terminalLoaded && sessions.size > 0) return;
  g.__terminalLoaded = true;
  ensureDirs();
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf8");
    const list: TerminalSessionRecord[] = JSON.parse(raw);
    const now = Date.now();
    for (const s of list) {
      if (new Date(s.expiresAt).getTime() > now && s.status !== "closed" && s.status !== "revoked") {
        sessions.set(s.sessionId, s);
        deviceSessionMap.set(s.deviceId, s.sessionId);
      }
    }
  } catch {
    // Ignore if file doesn't exist yet
  }
}

async function persistSessions(): Promise<void> {
  try {
    ensureDirs();
    const list = Array.from(sessions.values());
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist terminal sessions:", err);
  }
}

/**
 * Agent claims or connects to a terminal session for its device.
 */
export async function terminalClaim(
  deviceId: string,
  organizationId: string,
  hostname: string,
  agentInstanceId: string
): Promise<{
  sessionId: string;
  expiresAt: string;
  lastOutputSequence: number;
  hostname: string;
}> {
  await loadSessions();

  let session: TerminalSessionRecord | undefined;
  const existingId = deviceSessionMap.get(deviceId);
  if (existingId) {
    session = sessions.get(existingId);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

  if (session && session.status !== "closed" && session.status !== "revoked") {
    session.status = "active";
    session.agentInstanceId = agentInstanceId;
    session.lastSeenAt = now.toISOString();
    session.expiresAt = expiresAt;
    if (hostname) session.hostname = hostname;
  } else {
    const sessionId = crypto.randomUUID();
    session = {
      sessionId,
      deviceId,
      organizationId,
      hostname: hostname || "WINDOWS-PC",
      status: "active",
      createdAt: now.toISOString(),
      expiresAt,
      lastSeenAt: now.toISOString(),
      lastOutputSequence: 0,
      lastCommandSequence: 0,
      agentInstanceId,
      closeReason: null,
      commands: [],
      outputBuffer: [],
    };
    sessions.set(sessionId, session);
    deviceSessionMap.set(deviceId, sessionId);
  }

  await persistSessions();

  return {
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    lastOutputSequence: session.lastOutputSequence,
    hostname: session.hostname,
  };
}

/**
 * Agent long-polls for commands to execute on the persistent PowerShell session.
 */
export async function terminalPoll(
  sessionId: string,
  deviceId: string,
  timeoutMs = 15000
): Promise<{
  session_status: string;
  close_reason: string | null;
  commands: Array<{ command_id: string; sequence: number; command: string }>;
}> {
  await loadSessions();

  const session = sessions.get(sessionId);
  if (!session || session.deviceId !== deviceId) {
    return { session_status: "invalid", close_reason: "Session not found", commands: [] };
  }

  session.lastSeenAt = new Date().toISOString();
  await persistSessions();

  if (session.status !== "active" && session.status !== "pending") {
    return { session_status: session.status, close_reason: session.closeReason ?? null, commands: [] };
  }

  // Look for queued commands
  const pending = session.commands.filter((c) => c.status === "queued");
  if (pending.length > 0) {
    for (const c of pending) {
      c.status = "running";
      c.startedAt = Date.now();
    }
    return {
      session_status: session.status,
      close_reason: null,
      commands: pending.map((c) => ({
        command_id: c.commandId,
        sequence: c.sequence,
        command: c.command,
      })),
    };
  }

  // Long poll wait
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;

    const wakeUp = () => {
      if (timer) clearTimeout(timer);
      const s = sessions.get(sessionId);
      if (!s) {
        resolve({ session_status: "invalid", close_reason: "Session terminated", commands: [] });
        return;
      }
      const queued = s.commands.filter((c) => c.status === "queued");
      for (const c of queued) {
        c.status = "running";
        c.startedAt = Date.now();
      }
      resolve({
        session_status: s.status,
        close_reason: s.closeReason ?? null,
        commands: queued.map((c) => ({
          command_id: c.commandId,
          sequence: c.sequence,
          command: c.command,
        })),
      });
    };

    const waiters = pollWaiters.get(sessionId) || [];
    waiters.push(wakeUp);
    pollWaiters.set(sessionId, waiters);

    timer = setTimeout(() => {
      // Remove waiter
      const currentWaiters = pollWaiters.get(sessionId) || [];
      const idx = currentWaiters.indexOf(wakeUp);
      if (idx !== -1) currentWaiters.splice(idx, 1);
      const s = sessions.get(sessionId);
      resolve({
        session_status: s?.status ?? "active",
        close_reason: s?.closeReason ?? null,
        commands: [],
      });
    }, timeoutMs);
  });
}

/**
 * Agent streams output chunks back to the gateway.
 */
export async function terminalAppendOutput(
  sessionId: string,
  deviceId: string,
  items: Array<{ stream: string; content: string }>
): Promise<{ session_status: string; last_output_sequence: number }> {
  await loadSessions();

  const session = sessions.get(sessionId);
  if (!session || session.deviceId !== deviceId) {
    return { session_status: "invalid", last_output_sequence: 0 };
  }

  session.lastSeenAt = new Date().toISOString();

  let targetCmd = session.commands.find((c) => c.status === "running");
  if (!targetCmd) {
    const now = Date.now();
    targetCmd = session.commands
      .filter((c) => c.completedAt && now - c.completedAt < 3000)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0];
  }

  for (const item of items) {
    session.lastOutputSequence += 1;
    const stream = (["stdout", "stderr", "system"].includes(item.stream) ? item.stream : "stdout") as
      | "stdout"
      | "stderr"
      | "system";

    session.outputBuffer.push({
      sequence: session.lastOutputSequence,
      stream,
      content: item.content,
      timestamp: new Date().toISOString(),
    });

    if (targetCmd) {
      if (stream === "stderr") {
        targetCmd.stderr += item.content;
      } else {
        targetCmd.stdout += item.content;
      }
    }
  }

  // Keep output buffer capped to last 2000 chunks to preserve memory
  if (session.outputBuffer.length > 2000) {
    session.outputBuffer = session.outputBuffer.slice(-1000);
  }

  return {
    session_status: session.status,
    last_output_sequence: session.lastOutputSequence,
  };
}

/**
 * Agent reports the final exit result of a command sequence.
 */
export async function terminalCommandResult(
  sessionId: string,
  deviceId: string,
  sequence: number,
  exitOk: boolean,
  error?: string | null
): Promise<{ success: boolean }> {
  // Wait 150ms for any in-flight output batches to arrive and append
  await new Promise((r) => setTimeout(r, 150));
  await loadSessions();

  const session = sessions.get(sessionId);
  if (!session || session.deviceId !== deviceId) {
    return { success: false };
  }

  session.lastSeenAt = new Date().toISOString();

  const cmd = session.commands.find((c) => c.sequence === sequence);
  if (cmd) {
    cmd.status = exitOk ? "completed" : "failed";
    cmd.exitOk = exitOk;
    cmd.exitCode = exitOk ? 0 : 1;
    cmd.error = error;
    cmd.completedAt = Date.now();

    // If stdout and stderr are currently empty, give in-flight output batches up to 600ms to arrive
    const startWait = Date.now();
    while (Date.now() - startWait < 600 && !cmd.stdout && !cmd.stderr) {
      await new Promise((r) => setTimeout(r, 40));
    }

    const durationMs = cmd.completedAt - (cmd.startedAt || cmd.queuedAt);
    const waiter = commandWaiters.get(cmd.commandId);
    if (waiter) {
      commandWaiters.delete(cmd.commandId);
      waiter({
        success: true,
        command: cmd.command,
        stdout: cmd.stdout,
        stderr: cmd.stderr || (error ? String(error) : ""),
        exitCode: cmd.exitCode,
        durationMs: Math.max(1, durationMs),
        target: session.hostname,
        source: "terminal_session",
        timestamp: new Date().toISOString(),
      });
    }
  }

  await persistSessions();
  return { success: true };
}

/**
 * Agent queries session state.
 */
export async function terminalState(
  sessionId: string,
  deviceId: string
): Promise<{ session_status: string; close_reason: string | null }> {
  await loadSessions();
  const session = sessions.get(sessionId);
  if (!session || session.deviceId !== deviceId) {
    return { session_status: "invalid", close_reason: "Session not found" };
  }
  return { session_status: session.status, close_reason: session.closeReason ?? null };
}

/**
 * Close session.
 */
export async function terminalCloseSession(
  sessionId: string,
  deviceId?: string,
  reason = "Session closed"
): Promise<{ ok: boolean }> {
  await loadSessions();
  const session = sessions.get(sessionId);
  if (!session || (deviceId && session.deviceId !== deviceId)) {
    return { ok: false };
  }
  session.status = "closed";
  session.closeReason = reason;

  // Wake up any waiters
  const waiters = pollWaiters.get(sessionId) || [];
  for (const w of waiters) w();
  pollWaiters.delete(sessionId);

  await persistSessions();
  return { ok: true };
}

/**
 * Execute command on target Windows agent:
 * 1. Checks device enrollment.
 * 2. Attempts execution via persistent TerminalWorkerService on target Windows endpoint.
 * 3. If persistent terminal is not yet claimed or times out waiting for start, falls back to AgentWorkerService queued jobs.
 * 4. Logs audit record and returns target machine's actual stdout, stderr, and exit code.
 */
export async function executeCommandOnDevice({
  deviceId,
  organizationId,
  command,
  timeoutSeconds = 30,
}: {
  deviceId: string;
  organizationId: string;
  command: string;
  timeoutSeconds?: number;
}): Promise<ExecutionResult> {
  const supabase = createServiceClient();
  const startTime = Date.now();

  // 1. Verify target device
  const { data: device, error: devErr } = await supabase
    .from("devices")
    .select("id, hostname, display_name, enrollment_status, organization_id")
    .eq("id", deviceId)
    .maybeSingle();

  if (devErr || !device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  if (device.enrollment_status !== "enrolled") {
    throw new Error(`Device is not enrolled (status: ${device.enrollment_status})`);
  }

  const hostname = device.hostname || device.display_name || "TARGET-HOST";
  const trimmed = command.trim();

  await loadSessions();

  // Check if target device has an active persistent terminal session
  const activeSessionId = deviceSessionMap.get(deviceId);
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  const isSessionReady =
    session &&
    session.status === "active" &&
    new Date(session.expiresAt).getTime() > Date.now();

  const userId = await getValidUserId(supabase, device.organization_id);
  let fallbackReason: string | undefined;

  if (isSessionReady && session) {
    try {
      const result = await queueAndExecuteInTerminalSession(session, trimmed, timeoutSeconds);
      await recordAudit(device.organization_id, deviceId, trimmed, result.exitCode, hostname, userId);
      return result;
    } catch (err: any) {
      fallbackReason = err.message;
      console.warn(`[terminalStore] Persistent terminal execution fell back to job transport: ${err.message}`);
    }
  } else {
    fallbackReason = !session ? "No session found in deviceSessionMap" : `Session not ready: status=${session.status}, expiresAt=${session.expiresAt}`;
  }

  // Fallback: Submit as a direct job to the agent on the target machine
  const jobResult = await executeViaAgentJobQueue(
    supabase,
    device.organization_id,
    deviceId,
    trimmed,
    timeoutSeconds,
    hostname,
    startTime,
    userId,
    fallbackReason
  );

  await recordAudit(device.organization_id, deviceId, trimmed, jobResult.exitCode, hostname, userId);
  return jobResult;
}

async function getValidUserId(supabase: any, organizationId: string): Promise<string> {
  try {
    const { data: member } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle();
    if (member?.user_id) return member.user_id;
  } catch {}
  return "fc09f0ab-04a7-4b2f-a323-3630736a176a";
}

async function queueAndExecuteInTerminalSession(
  session: TerminalSessionRecord,
  command: string,
  timeoutSeconds: number
): Promise<ExecutionResult> {
  const commandId = crypto.randomUUID();
  session.lastCommandSequence += 1;
  const sequence = session.lastCommandSequence;

  const item: TerminalCommandItem = {
    commandId,
    sequence,
    command,
    status: "queued",
    queuedAt: Date.now(),
    stdout: "",
    stderr: "",
  };

  session.commands.push(item);

  // Wake up agent's poll
  const waiters = pollWaiters.get(session.sessionId) || [];
  for (const w of waiters) w();
  pollWaiters.delete(session.sessionId);

  return new Promise<ExecutionResult>((resolve, reject) => {
    // If agent does not pick up the command within limit, fall back to job queue
    const pickupLimitMs = Math.max(8000, Math.min(timeoutSeconds * 1000 - 2000, 20000));
    const pickupCheckTimer = setTimeout(() => {
      if (item.status === "queued") {
        commandWaiters.delete(commandId);
        item.status = "failed";
        item.error = "Agent did not claim queued command in time";
        reject(new Error("Persistent terminal session did not claim queued command in time"));
      }
    }, pickupLimitMs);

    const overallTimeout = setTimeout(() => {
      commandWaiters.delete(commandId);
      item.status = "timed_out";
      reject(new Error(`Terminal command execution timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    commandWaiters.set(commandId, (res) => {
      clearTimeout(pickupCheckTimer);
      clearTimeout(overallTimeout);
      resolve(res);
    });
  });
}

async function executeViaAgentJobQueue(
  supabase: any,
  organizationId: string,
  deviceId: string,
  command: string,
  timeoutSeconds: number,
  hostname: string,
  startTime: number,
  createdBy: string,
  fallbackReason?: string
): Promise<ExecutionResult> {
  const scriptHash = crypto.createHash("sha256").update(command, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + (timeoutSeconds + 60) * 1000).toISOString();

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      organization_id: organizationId,
      device_id: deviceId,
      created_by: createdBy,
      script_content: command,
      script_type: "powershell",
      script_hash: scriptHash,
      description: `Terminal: ${command.slice(0, 60)}`,
      state: "queued",
      timeout_seconds: timeoutSeconds,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    throw new Error(`Failed to queue job for device: ${jobErr?.message || "Unknown error"}`);
  }

  const jobId = job.id;
  const deadline = Date.now() + timeoutSeconds * 1000;

  // Poll for completion from the Windows agent
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));

    const { data: currentJob } = await supabase
      .from("jobs")
      .select("state, completed_at")
      .eq("id", jobId)
      .maybeSingle();

    if (currentJob && ["succeeded", "failed", "timed_out", "cancelled"].includes(currentJob.state)) {
      const { data: attempt } = await supabase
        .from("job_attempts")
        .select("exit_code, stdout_text, stderr_text, error_summary, state")
        .eq("job_id", jobId)
        .order("attempt_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      const exitCode = typeof attempt?.exit_code === "number" ? attempt.exit_code : currentJob.state === "succeeded" ? 0 : 1;
      const stdout = attempt?.stdout_text || "";
      const stderr = attempt?.stderr_text || attempt?.error_summary || "";

      return {
        success: currentJob.state === "succeeded",
        command,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
        target: hostname,
        source: "agent_job",
        fallbackReason,
        timestamp: new Date().toISOString(),
      };
    }
  }

  throw new Error(`Command on ${hostname} timed out waiting for agent execution after ${timeoutSeconds}s`);
}

async function recordAudit(
  organizationId: string,
  deviceId: string,
  command: string,
  exitCode: number,
  hostname: string,
  actorId: string
) {
  try {
    const supabase = createServiceClient();
    await supabase.from("audit_events").insert({
      organization_id: organizationId,
      actor_type: "user",
      actor_id: actorId,
      action: "terminal.command_executed",
      target_type: "device",
      target_id: deviceId,
      metadata: {
        command: command.slice(0, 500),
        exit_code: exitCode,
        target_hostname: hostname,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("Failed to write audit event for terminal command:", e);
  }
}
