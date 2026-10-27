# ScriptRunner Windows Agent — Installation & Setup Guide

This guide covers installing, enrolling, verifying, and removing the ScriptRunner Windows Agent on corporate Windows devices.

---

## 1. System Requirements

- **Operating System**: Windows 11, Windows 10 (Build 1809+), or Windows Server 2019 / 2022 (x64 architecture).
- **Runtime**: .NET 8.0 Runtime or SDK (included if using self-contained bundle).
- **PowerShell**: PowerShell 7 (preferred) or Windows PowerShell 5.1.
- **Privileges**: Local Administrator privileges are required to install and register the Windows Service.
- **Network**: Outbound HTTPS (TCP port 443) connectivity to your company Supabase endpoint. No inbound ports required.

---

## 2. Enrollment & Installation Steps

### Step 1: Generate an Enrollment Invitation
1. Log into the ScriptRunner Web Dashboard as an **Administrator** or **Owner**.
2. Navigate to **Devices**.
3. Click **Enroll New Device**.
4. Enter the computer's display name (e.g. `Finance-Laptop-04`).
5. Choose token expiry (default: 24 hours).
6. Click **Generate Enrollment Invitation**.
7. Copy the generated **One-Time Token** or the complete PowerShell enrollment command.

### Step 2: Run Installer on Target Computer
Open an **elevated PowerShell console** (Run as Administrator) on the target Windows machine.

Navigate to the agent package directory:
```powershell
cd C:\Path\To\ScriptRunnerAgent
```

Run `install-service.ps1` with your Supabase URL and the single-use invitation token:
```powershell
.\install-service.ps1 `
    -SupabaseUrl "https://your-project.supabase.co" `
    -InvitationToken "<64-character-token-from-dashboard>"
```

The script will:
1. Contact Supabase Edge Function to redeem the invitation token.
2. Receive a unique device identity and secret API key.
3. Install binaries to `C:\Program Files\ScriptRunnerAgent` with anti-tampering NTFS ACLs.
4. Create the protected local state folder `C:\ProgramData\ScriptRunnerAgent\state`.
5. Register and start the `ScriptRunnerAgent` Windows Service.

---

## 3. Verification

### 3.1 Check Windows Service Status
```powershell
Get-Service ScriptRunnerAgent
```
Status should report `Running`.

### 3.2 Check Windows Event Log
ScriptRunner logs lifecycle events to the Windows Application Event Log:
```powershell
Get-EventLog -LogName Application -Source "ScriptRunnerAgent" -Newest 10
```

### 3.3 Check Web Dashboard
Return to **Dashboard > Devices**.
- The device should now appear with an **Online** status indicator.
- Heartbeat timestamp (`Last Seen`) will refresh automatically every 30 seconds.

---

## 4. Uninstallation / Removal

To completely stop and remove the agent from a computer:
1. Open an elevated PowerShell prompt.
2. Run the uninstaller script:
```powershell
cd "C:\Program Files\ScriptRunnerAgent"
.\uninstall-service.ps1
```
The uninstaller stops the running service, unregisters it from Windows Service Control Manager (`sc.exe delete`), and deletes the installation directories.

To revoke access centrally without local access to the computer:
- Navigate to **Dashboard > Devices > [Target Device]** and click **Revoke Device**.
- The server will immediately reject all subsequent requests from that computer.
