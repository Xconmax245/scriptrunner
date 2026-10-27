# ScriptRunner — Authorized Corporate Remote Script Execution Platform

ScriptRunner is an enterprise platform allowing authenticated corporate administrators to select enrolled Windows computers, write or paste PowerShell scripts in a modern web dashboard, and dispatch jobs. An installed Windows background service on the assigned computer retrieves the job over outbound HTTPS, executes it as a background task under its configured Windows permissions (without popping interactive terminal windows), and reports structured execution results back to the dashboard.

---

## Architecture Overview

```mermaid
flowchart LR
    subgraph Browser["Admin Web Console"]
        UI[Next.js App Router / Tailwind]
        Editor[Monaco PowerShell Editor]
        Sync[Realtime & Polling Fallback]
    end

    subgraph Supabase["Supabase Cloud / Local Backend"]
        Auth[Supabase Auth]
        DB[(PostgreSQL + RLS)]
        Edge[Edge Functions]
        RT[Supabase Realtime]
    end

    subgraph WindowsHost["Target Windows PC"]
        Agent[ScriptRunnerAgent Windows Service]
        State[(Local State Cache)]
        PS[PowerShell Subprocess Engine]
    end

    UI -->|Admin Session| Auth
    UI -->|Submit Job / Revoke| Edge
    UI -->|Live Updates| RT
    Edge -->|Service Role| DB
    DB -.->|Table Change Events| RT
    Agent -->|Heartbeat & Polling| DB
    Agent -->|Device Auth / Redeem| Edge
    Agent -->|Persist In-Flight| State
    Agent -->|Execute Script (Session 0)| PS
    PS -->|Bounded Stdout / Stderr| Agent
    Agent -->|Atomic Result Report| DB
```

---

## Key Capabilities & Security Controls

1. **No Inbound Ports**: Agent initiates strictly outbound TLS 1.3 / 1.2 connections. No client port forwarding or public IP exposure required.
2. **Invisible Background Execution**: Ordinary scripts run with `CreateNoWindow = true`, `UseShellExecute = false`, and `WindowStyle = Hidden` in Session 0. No PowerShell or Command Prompt console appears on the user's desktop.
3. **Multi-Tenant Isolation**: Row Level Security (RLS) is enabled across all tables (`organizations`, `devices`, `jobs`, `job_attempts`, `audit_events`, `organization_settings`).
4. **Single-Use Expiring Enrollment**: Devices enroll through one-time invitation tokens. Plaintext tokens are never stored (only SHA-256 hashes).
5. **Atomic Claiming**: `FOR UPDATE SKIP LOCKED` database transactions prevent duplicate execution or race conditions between concurrent agent instances.
6. **Output Bounding & Secret Redaction**: Stdout is capped at 64 KB and stderr at 16 KB. Passwords, bearer tokens, API keys, and secrets are redacted in-memory prior to transmission.
7. **Offline Job Queue**: If a device is offline, jobs remain safely queued in Supabase (`waiting_for_device`). When connectivity returns, the agent retrieves eligible jobs and executes them.
8. **Crash Recovery & Reconciliation**: Interrupted jobs due to sudden power loss are reconciled to `outcome_unknown` upon agent restart rather than blindly re-executed.

---

## Directory Structure

```
├── agent/                     # .NET 8.0 LTS Windows Service
│   ├── Configuration/         # AgentOptions & settings binding
│   ├── Models/                # RPC and DTO models
│   ├── Services/              # SupabaseApiClient, JobExecutionEngine, StatePersistenceManager
│   ├── Worker/                # AgentWorkerService (BackgroundService loop)
│   ├── Installer/             # install-service.ps1 & uninstall-service.ps1
│   ├── publish/               # Published release distribution package
│   └── ScriptRunnerAgent.csproj
├── dashboard/                 # Next.js 16 (App Router) + TypeScript + Tailwind CSS
│   ├── src/
│   │   ├── app/               # Routes: /auth, /dashboard, /devices, /jobs, /settings
│   │   ├── components/        # UI components (Monaco Editor, Badges, Modals, Tables)
│   │   ├── hooks/             # useRealtimeSync (Supabase Realtime + Polling fallback)
│   │   ├── lib/               # Supabase SSR and browser clients
│   │   └── types/             # database.ts schema types
│   ├── package.json
│   └── tsconfig.json
├── supabase/                  # Database schema & Serverless Edge Functions
│   ├── migrations/            # 001_initial_schema, 002_jobs_schema, 003_rls_policies, 004_atomic_rpcs, 005_seed_dev
│   └── functions/             # device-auth, create-invitation, redeem-invitation, submit-job, cancel-job, revoke-device
├── tests/                     # Test suites
│   ├── agent/                 # xUnit tests for Windows Agent (.NET 8)
│   ├── policies/              # SQL RLS & multi-tenant isolation tests
│   └── e2e/                   # End-to-end integration test runner
├── AGENT_INSTALL.md           # Step-by-step Windows Agent installation guide
├── DEPLOYMENT.md              # Production deployment & operations guide
├── SECURITY.md                # Threat model, incident response & security policy
└── README.md                  # System overview and quickstart
```

---

## Quickstart Guide

### 1. Start Local Supabase
```bash
supabase start
supabase db reset
```

### 2. Run Admin Dashboard
```bash
cd dashboard
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) and sign in.

### 3. Build & Install Windows Agent
In an elevated PowerShell prompt:
```powershell
# Build agent package
dotnet publish agent\ScriptRunnerAgent.csproj -c Release -o agent\publish
Copy-Item "agent\Installer\*" "agent\publish\" -Force

# Install service with an invitation token generated from Dashboard > Devices:
cd agent\publish
.\install-service.ps1 -SupabaseUrl "http://127.0.0.1:54321" -InvitationToken "<token>"
```

---

## Automated Test Results

### 1. Windows Agent Unit Tests (`xUnit` / .NET 8)
All 10 unit tests pass successfully:
```
  Passed SupabaseApiClientTests.AuthenticateAsync_ValidCredentials_CachesToken
  Passed SupabaseApiClientTests.SendHeartbeatAsync_SendsCorrectPayloadAndAcknowledges
  Passed StatePersistenceManagerTests.ClearInFlightState_RemovesFileCleanly
  Passed StatePersistenceManagerTests.SaveAndLoad_InFlightState_RoundTripsCorrectly
  Passed StatePersistenceManagerTests.UpdateCompletedResult_CachesResultForCrashRecovery
  Passed JobExecutionEngineTests.ExecuteScriptAsync_ValidScript_ReturnsStdoutAndZeroExitCode
  Passed JobExecutionEngineTests.ExecuteScriptAsync_FailingScript_ReturnsStderrAndNonZeroExitCode
  Passed JobExecutionEngineTests.ExecuteScriptAsync_LongRunningScript_TimesOutAndKillsProcess
  Passed JobExecutionEngineTests.ExecuteScriptAsync_SensitiveData_IsRedactedFromOutput
  Passed JobExecutionEngineTests.ExecuteScriptAsync_ExceedsOutputLimit_TruncatesGracefully

Test Run Successful. Total tests: 10, Passed: 10 (Duration: 11.1s)
```

### 2. Frontend Build Verification
Next.js production bundle compiles cleanly with 0 TypeScript errors across all 10 application routes:
```
✓ Compiled successfully in 3.0s
✓ Running TypeScript passed with 0 errors
✓ Generated static & dynamic pages (10/10)
```

### 3. E2E Protocol Validation
Cryptographic contracts and state transition validations pass:
```
  [PASS] SHA-256 token hash produces 64-character hex digest
  [PASS] Token prefix extraction matches 8 chars
  [PASS] State transition queued -> claimed is valid
  [PASS] Ambiguous restart outcome_unknown is supported
```

---

## Troubleshooting Guide

| Issue | Cause | Resolution |
|---|---|---|
| Service status shows `Stopped` in `services.msc` | Invalid credentials in `appsettings.json` or target host unreachable. | Inspect Windows Application Event Log (`Source: ScriptRunnerAgent`) for exact HTTP error code. |
| Dashboard shows device as `Offline` | Device hasn't sent a heartbeat in >90 seconds. | Check if host has network access to Supabase URL or if service was manually stopped. |
| Job state remains `waiting_for_device` | Assigned PC is offline or turned off. | Job will automatically execute as soon as the agent reconnects (before expiry deadline). |
| Script fails with exit code -1 | Process exceeded configured timeout. | Increase `timeout_seconds` when submitting the job if the task requires longer duration. |
| "Session expired" in Web UI | Supabase Auth JWT expired. | Sign out and sign in again to refresh browser session. |

---

## Known Limitations & Future Work

1. **Abrupt Power Loss**: If a host suffers abrupt power loss during script execution, the agent marks the job `outcome_unknown` upon reboot to avoid blind duplicate execution.
2. **Interactive Desktop GUI**: Scripts that require interactive desktop popups (e.g. `[System.Windows.Forms.MessageBox]::Show`) are unsupported by design in Session 0 background services and should not be dispatched.
