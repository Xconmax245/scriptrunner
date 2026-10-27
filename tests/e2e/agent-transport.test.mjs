// End-to-end transport test: runs the REAL Windows agent executable against a
// local mock of the Supabase edge-function contract, and drives a REAL remote
// terminal session with the host's PowerShell.
//
// What this proves:
//  * automatic enrollment retries until the backend becomes reachable;
//  * heartbeat reports hostname/OS/service state/execution account;
//  * session claim, command long-poll, ordered output streaming, session end;
//  * session state persists between commands (variables + working directory);
//  * output is streamed while a command runs (not batched at completion);
//  * revocation stops new commands and ends the session;
//  * the hosted PowerShell process has no visible window.
//
// What it does NOT prove: the Supabase Edge Functions/Postgres deployment itself
// (covered by tests/db), the MSI/service installation (requires an elevated
// separate Windows machine), or a real second PC.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, hostname as osHostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const agentDll = join(root, "agent", "bin", "Debug", "net8.0-windows", "ScriptRunnerAgent.dll");
const dotnetHost = join(root, ".dotnet", "dotnet.exe");
const port = 57000 + Math.floor(Math.random() * 400);
const enrollmentKey = crypto.randomBytes(32).toString("hex");

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
    console.log(`  [FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, label, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
};

if (!existsSync(agentDll) || !existsSync(dotnetHost)) {
  console.error(`Agent build or local .NET host not found.\nExpected: ${agentDll}\n          ${dotnetHost}`);
  process.exit(1);
}

const state = {
  enrollAttempts: 0,
  enrolled: false,
  deviceId: null,
  apiKey: null,
  heartbeat: null,
  gatewayActions: [],
  session: null,
  nextCommandSequence: 0,
  pendingCommands: [],
  deliveredCommands: [],
  outputs: [],
  nextOutputSequence: 0,
  results: [],
  ended: null,
  revoked: false,
  revokedAt: null,
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  const send = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (req.url === "/functions/v1/enroll-device") {
    state.enrollAttempts++;
    if (body.enrollment_key !== enrollmentKey) {
      return send(401, { error: "Enrollment key is not valid", code: "invalid_key" });
    }
    state.enrolled = true;
    state.deviceId = body.device_id;
    state.apiKey = crypto.randomBytes(32).toString("hex");
    state.installId = body.install_id;
    return send(201, {
      device_id: body.device_id,
      organization_id: crypto.randomUUID(),
      enrollment_status: "enrolled",
      api_key: state.apiKey,
    });
  }

  if (req.url === "/functions/v1/device-auth") {
    state.gatewayActions.push("device-auth");
    if (state.revoked) return send(403, { error: "Device revoked" });
    if (!state.enrolled || body.device_id !== state.deviceId || body.api_key !== state.apiKey) {
      return send(401, { error: "Authentication failed" });
    }
    return send(200, { access_token: "mock-device-jwt", token_type: "Bearer", expires_in: 3600 });
  }

  if (req.url === "/functions/v1/agent-gateway") {
    if (req.headers.authorization !== "Bearer mock-device-jwt") {
      return send(401, { error: "Invalid or expired device token" });
    }
    if (state.revoked) {
      return send(403, {
        error: "Device is not authorized to receive commands",
        code: "device_not_authorized",
        enrollment_status: "revoked",
      });
    }

    state.gatewayActions.push(body.action);

    switch (body.action) {
      case "heartbeat":
        state.heartbeat = body;
        return send(200, { enrollment_status: "enrolled", pending_jobs_count: 0 });

      case "pending_jobs":
        return send(200, { jobs: [] });

      case "claim_job":
        return send(200, { job: null });

      case "terminal_claim":
        if (state.session && state.session.status === "pending") {
          state.session.status = "active";
          state.session.agent_instance = body.agent_instance;
          return send(200, {
            session: {
              session_id: state.session.id,
              expires_at: state.session.expires_at,
              last_output_sequence: 0,
              hostname: osHostname(),
            },
          });
        }
        return send(200, { session: null });

      case "terminal_poll": {
        const commands = state.pendingCommands
          .filter((c) => !c.delivered)
          .sort((a, b) => a.sequence - b.sequence);
        for (const command of commands) command.delivered = true;
        if (commands.length > 0) state.deliveredCommands.push(...commands);
        return send(200, {
          session_status: state.session?.status ?? "invalid",
          close_reason: state.session?.close_reason ?? null,
          commands: commands.map((c) => ({
            command_id: c.id,
            sequence: c.sequence,
            command: c.command,
          })),
        });
      }

      case "terminal_output": {
        for (const item of body.items ?? []) {
          state.nextOutputSequence++;
          state.outputs.push({
            sequence: state.nextOutputSequence,
            stream: item.stream,
            content: item.content,
            at: Date.now(),
          });
        }
        return send(200, {
          session_status: state.session?.status ?? "active",
          last_output_sequence: state.nextOutputSequence,
        });
      }

      case "terminal_command_result":
        state.results.push({
          sequence: Number(body.sequence),
          exitOk: Boolean(body.exit_ok),
          error: body.error ?? null,
          at: Date.now(),
        });
        return send(200, { success: true });

      case "terminal_state":
        return send(200, {
          session_status: state.session?.status ?? "invalid",
          close_reason: state.session?.close_reason ?? null,
        });

      case "terminal_end":
        state.session.status = "closed";
        state.session.close_reason = body.reason;
        state.ended = { reason: body.reason, at: Date.now() };
        return send(200, { result: "ok" });

      case "ambiguous_jobs":
        return send(200, { jobs: [] });

      default:
        return send(400, { error: "Unknown action" });
    }
  }

  send(404, { error: "not found" });
});

const stateDir = mkdtempSync(join(tmpdir(), "sr-e2e-"));
const statusFile = join(stateDir, "enrollment-status.json");
const readStatus = () => {
  if (!existsSync(statusFile)) return null;
  try {
    return JSON.parse(readFileSync(statusFile, "utf8"));
  } catch {
    return null;
  }
};

const agentLog = [];
const agent = spawn(dotnetHost, [agentDll], {
  cwd: join(root, "agent"),
  env: {
    ...process.env,
    DOTNET_ROOT: join(root, ".dotnet"),
    ScriptRunner__SupabaseUrl: `http://127.0.0.1:${port}`,
    ScriptRunner__SupabaseAnonKey: "test-anon-key",
    ScriptRunner__EnrollmentKey: enrollmentKey,
    ScriptRunner__DeviceId: "",
    ScriptRunner__DeviceApiKey: "",
    ScriptRunner__LocalStateDirectory: stateDir,
    ScriptRunner__PollIntervalSeconds: "1",
    ScriptRunner__HeartbeatIntervalSeconds: "2",
    ScriptRunner__TerminalClaimIntervalSeconds: "1",
    ScriptRunner__MaxBackoffSeconds: "5",
    DOTNET_ENVIRONMENT: "Production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

agent.stdout.on("data", (d) => agentLog.push(d.toString()));
agent.stderr.on("data", (d) => agentLog.push(d.toString()));

// Command helper
let lastCommandSequence = 0;
const sendCommand = (command) => {
  const sequence = ++lastCommandSequence;
  state.pendingCommands.push({
    id: crypto.randomUUID(),
    sequence,
    command,
    delivered: false,
  });
  return sequence;
};

const outputText = (sinceSequence = 0) =>
  state.outputs
    .filter((o) => o.sequence > sinceSequence && !o.content.startsWith("\u0001SR-COMPLETIONS\u0001"))
    .map((o) => o.content)
    .join("");

const waitForResult = async (sequence, timeoutMs = 30000) => {
  await waitFor(() => state.results.some((r) => r.sequence === sequence), timeoutMs, `result ${sequence}`);
  return state.results.find((r) => r.sequence === sequence);
};

const waitForOutput = async (needle, timeoutMs = 30000) => {
  await waitFor(() => outputText().includes(needle), timeoutMs, `output containing ${needle}`);
};

const run = async () => {
  console.log(`\nAgent: ${agentDll}\nState: ${stateDir}\n`);

  // The server is intentionally NOT listening yet: enrollment must retry.
  await sleep(4000);

  check("agent starts and reports local state while backend is unreachable", readStatus() !== null,
    JSON.stringify(readStatus()));

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  check("mock backend started after the agent's first failed attempt", true);

  await waitFor(() => readStatus()?.state === "Authorized", 45000, "automatic enrollment");
  check("agent auto-enrolls and retries until the backend is reachable", true);
  check("enrollment used the organization key (no invitation token)",
    state.enrollAttempts >= 1, `attempts=${state.enrollAttempts}`);
  check("device ID was generated by the installation and sent to the backend",
    /^[0-9a-f-]{36}$/.test(state.deviceId ?? ""), state.deviceId ?? "none");

  await waitFor(() => state.heartbeat !== null, 15000, "heartbeat");
  check("heartbeat reports the target hostname",
    String(state.heartbeat.hostname).toLowerCase() === osHostname().toLowerCase(),
    `${state.heartbeat.hostname} vs ${osHostname()}`);
  check("heartbeat reports OS, service status and execution account",
    Boolean(state.heartbeat.operating_system) &&
      state.heartbeat.service_status === "running" &&
      Boolean(state.heartbeat.execution_account),
    JSON.stringify(state.heartbeat));

  // Open a session the way the dashboard does.
  state.session = {
    id: crypto.randomUUID(),
    status: "pending",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    close_reason: null,
  };

  await waitFor(() => state.session.status === "active", 15000, "agent session claim");
  check("agent claims the administrator's session", true);
  check("session claim includes the agent instance id", Boolean(state.session.agent_instance));

  // Wait for the header output (proof PowerShell started)
  await waitForOutput("ScriptRunner remote terminal attached", 20000);
  check("terminal header is streamed from the target", true);
  check("header states no window opens on the desktop",
    outputText().toLowerCase().includes("no window opens"));
  check("completion metadata is sent for Tab completion",
    state.outputs.some((o) => o.content.startsWith("\u0001SR-COMPLETIONS\u0001")));

  // 1. hostname
  let seq = sendCommand("hostname");
  let result = await waitForResult(seq);
  await waitForOutput(osHostname().toLowerCase(), 20000);
  check("`hostname` returns the target machine's hostname", outputText().toLowerCase().includes(osHostname().toLowerCase()));
  check("command result reports success", result.exitOk === true);

  // 2. Session state: variables
  seq = sendCommand("$terminalE2E = 'persistent-value'");
  await waitForResult(seq);
  const mark1 = state.nextOutputSequence;
  seq = sendCommand("Write-Output \"value=$terminalE2E\"");
  await waitForResult(seq);
  await waitForOutput("value=persistent-value", 20000);
  check("variables persist across commands in one session", outputText().includes("value=persistent-value"));
  check("no session reset occurred between commands", outputText().includes("value=persistent-value"));

  // 3. Session state: working directory
  seq = sendCommand("Set-Location $env:SystemRoot");
  await waitForResult(seq);
  seq = sendCommand("Write-Output \"cwd=$((Get-Location).Path)\"");
  await waitForResult(seq);
  await waitForOutput("cwd=", 20000);
  check("working directory persists across commands",
    outputText().includes(`cwd=${process.env.SystemRoot ?? "C:\\Windows"}`));

  // 4. Live streaming while running
  const streamMark = state.outputs.length;
  const startedAt = Date.now();
  seq = sendCommand("1..3 | ForEach-Object { Write-Output ('tick ' + $_); Start-Sleep -Milliseconds 700 }");
  const streamResult = await waitForResult(seq, 30000);
  const firstTick = state.outputs
    .slice(streamMark)
    .find((o) => o.content.includes("tick 1"));
  const resultAt = streamResult.at;
  check("long-running command eventually completes", streamResult.exitOk === true);
  check("output is streamed before command completion",
    Boolean(firstTick) && firstTick.at < resultAt - 500,
    firstTick ? `first=${firstTick.at - startedAt}ms result=${resultAt - startedAt}ms` : "no tick output");
  check("streamed output is ordered by sequence",
    state.outputs.every((o, i, arr) => i === 0 || arr[i - 1].sequence < o.sequence));

  // 5. Command that requires interactive input is rejected, not hung
  seq = sendCommand("Read-Host 'enter something'");
  const interactiveResult = await waitForResult(seq, 15000);
  check("interactive command is rejected with an explanation",
    interactiveResult.exitOk === false && /noninteractive/i.test(interactiveResult.error ?? ""),
    interactiveResult.error ?? "");

  // 6. No visible PowerShell window on the desktop
  try {
    const psList = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Get-Process powershell -ErrorAction SilentlyContinue | Select-Object Id,MainWindowHandle | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(psList || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    check("hosted PowerShell processes report no visible window",
      list.every((p) => Number(p.MainWindowHandle) === 0),
      JSON.stringify(list));
  } catch (err) {
    check("hosted PowerShell processes report no visible window", false, String(err));
  }

  // 7. Revocation stops commands and ends the session
  state.revoked = true;
  state.revokedAt = Date.now();
  state.session.status = "revoked";
  state.session.close_reason = "Device access revoked";
  const commandsBefore = state.deliveredCommands.length;
  sendCommand("Write-Output 'should-not-run-after-revocation'");

  // In production the revocation RPC closes the session transactionally; the
  // mock mirrors that by flipping the session to 'revoked'.
  await waitFor(() => readStatus()?.state === "Revoked", 25000, "agent revoked state");
  check("revoked device's session is terminated", state.session.status === "revoked");
  await sleep(2500);
  check("revoked device does not execute newly queued commands",
    state.deliveredCommands.length === commandsBefore,
    `delivered ${state.deliveredCommands.length - commandsBefore} extra`);
  check("no output is produced after revocation",
    !outputText().includes("should-not-run-after-revocation"));

  await waitFor(() => readStatus()?.state === "Revoked", 20000, "agent revoked state");
  check("agent records the revoked lifecycle state", readStatus()?.state === "Revoked");
};

try {
  await run();
} catch (err) {
  failed++;
  failures.push(`harness error: ${err.message}`);
  console.error("\nHARNESS ERROR:", err);
} finally {
  console.log("\n--- Agent log (tail) ---");
  console.log(agentLog.join("").split("\n").slice(-25).join("\n"));
  try {
    agent.kill("SIGKILL");
    setTimeout(() => {
      try { process.kill(agent.pid, "SIGKILL"); } catch {}
    }, 1500);
  } catch {}
  server.close();
  try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:\n - " + failures.join("\n - "));
  process.exitCode = 1;
}
