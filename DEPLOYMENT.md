# ScriptRunner — Deployment & Operations Guide

This guide details the complete production deployment procedure for the Supabase backend, Next.js administrator dashboard, and Windows Agent background service.

---

## 1. Prerequisites

- **Supabase**: Supabase CLI (`v1.140+`) or Supabase Cloud project.
- **Frontend**: Node.js `v20.x` or `v22.x` LTS, npm `10+`.
- **Windows Agent**: .NET 8.0 SDK, Windows 10/11 or Windows Server 2019/2022.
- **Signing**: Windows SDK `signtool.exe` and Authenticode Code Signing Certificate (EV or OV).

---

## 2. Supabase Backend Deployment

### Step 2.1: Local Development & Migrations
```bash
# Start local Supabase container stack
supabase start

# Apply committed SQL migrations in order
supabase db reset
```

For a cloud-hosted Supabase project:
```bash
# Link local repository to cloud project
supabase link --project-ref your-project-ref

# Push database migrations to remote project
supabase db push
```

### Step 2.2: Set Edge Function Secrets
Generate a cryptographically random 32-byte hexadecimal signing secret for device tokens:
```bash
# In PowerShell:
$secret = -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
Write-Output $secret
```

Set the secret in Supabase:
```bash
supabase secrets set DEVICE_JWT_SECRET="<your-32-byte-hex-string>"
```

### Step 2.3: Deploy Edge Functions
Deploy the six privileged edge functions:
```bash
supabase functions deploy create-invitation --no-verify-jwt
supabase functions deploy redeem-invitation --no-verify-jwt
supabase functions deploy device-auth --no-verify-jwt
supabase functions deploy submit-job
supabase functions deploy cancel-job
supabase functions deploy revoke-device
```

---

## 3. Administrator Dashboard Deployment

### Step 3.1: Environment Variables
Create `.env.production` or configure environment variables in your deployment host (e.g. Vercel, AWS ECS, Cloudflare):
```ini
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Step 3.2: Build and Test
```bash
cd dashboard
npm ci
npm run build
```

### Step 3.3: Production Hosting
Run using Next.js standalone server:
```bash
npm run start
```
Or deploy directly via Vercel CLI:
```bash
vercel --prod
```

---

## 4. Windows Agent Build & Packaging

### Step 4.1: Release Compilation
```powershell
# In PowerShell:
cd c:\Users\USER\Downloads\.EXE
dotnet publish agent\ScriptRunnerAgent.csproj -c Release -o agent\publish
```

### Step 4.2: Copy Installer Scripts
```powershell
Copy-Item "agent\Installer\*" "agent\publish\" -Force
```

### Step 4.3: Authenticode Code Signing (Production)
Sign the executable using your corporate Code Signing Certificate to establish identity and prevent tampering warnings:
```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
    /tr http://timestamp.digicert.com `
    /td sha256 `
    /fd sha256 `
    /a `
    "agent\publish\ScriptRunnerAgent.exe"
```

Verify signature:
```powershell
& signtool.exe verify /pa /v "agent\publish\ScriptRunnerAgent.exe"
```
*(Note: Code signing establishes publisher identity, but initial SmartScreen reputation on new binaries builds over time based on download volume.)*

---

## 5. Production Operations Checklist

- [ ] **TLS Enforced**: Ensure all traffic to Supabase is strictly HTTPS (TLS 1.2+ minimum, TLS 1.3 preferred).
- [ ] **RLS Enabled**: Verify that every table in PostgreSQL shows `rowsecurity = true`.
- [ ] **Service Role Key Isolated**: Confirm `SUPABASE_SERVICE_ROLE_KEY` is not present in dashboard bundle or agent configuration.
- [ ] **Device Token Expiry**: Confirm `DEVICE_JWT_SECRET` is set in Supabase secrets and JWT lifetime is bounded (default: 1 hour).
- [ ] **NTFS Permissions**: Confirm `install-service.ps1` was executed with restrictive permissions on `%ProgramFiles%\ScriptRunnerAgent`.
- [ ] **Database Backups**: Verify automated Point-In-Time-Recovery (PITR) is enabled in Supabase project settings.
- [ ] **Monitoring & Heartbeats**: Set up an alerting rule for devices whose `last_seen_at` is older than 15 minutes.
