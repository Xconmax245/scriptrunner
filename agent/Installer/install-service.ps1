<#
.SYNOPSIS
    ScriptRunner Authorized Windows Agent Installer

.DESCRIPTION
    Installs the ScriptRunner Windows Service, generates a local device identity,
    configures organization-level enrollment (no per-device invitation token or
    typed device ID), starts the service, persists hostname/OS/heartbeat telemetry
    and prints "Installation successful" once local installation checks pass.

    Backend registration retries automatically in the background if the network or
    the ScriptRunner backend is temporarily unavailable.

.PARAMETER SupabaseUrl
    Base URL of the ScriptRunner Supabase project, e.g. https://abc.supabase.co

.PARAMETER EnrollmentKey
    Organization-level enrollment key generated once in
    Dashboard > Devices > Enrollment policy. This is NOT a per-device token.

.PARAMETER SupabaseAnonKey
    Public anon key for the Supabase project. If omitted, the value shipped in the
    adjacent appsettings.json is used.

.PARAMETER ServiceAccount
    VirtualServiceAccount (default, least privilege) or LocalSystem. Elevated
    operations are an explicit opt-in policy, not the default.

.PARAMETER FreshIdentity
    Delete any previously generated device identity and enroll as a new device.

.PARAMETER InstallDir
    Target directory for agent binaries. Default: $env:ProgramFiles\ScriptRunnerAgent

.PARAMETER StateDir
    Target directory for runtime state/credentials. Default: $env:ProgramData\ScriptRunnerAgent\state
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SupabaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$EnrollmentKey,

    [Parameter(Mandatory = $false)]
    [string]$SupabaseAnonKey,

    [ValidateSet("VirtualServiceAccount", "LocalSystem")]
    [string]$ServiceAccount = "VirtualServiceAccount",

    [switch]$FreshIdentity,

    [string]$InstallDir = "$env:ProgramFiles\ScriptRunnerAgent",
    [string]$StateDir = "$env:ProgramData\ScriptRunnerAgent\state"
)

$ErrorActionPreference = "Stop"
$serviceName = "ScriptRunnerAgent"
$identityFile = Join-Path $StateDir "device.json"
$statusFile = Join-Path $StateDir "enrollment-status.json"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ScriptRunner Authorized Windows Agent Installation" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Require Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Administrator privileges are required to install the ScriptRunner Windows Service. Rerun from an elevated PowerShell window."
    exit 1
}

# 2. Informed authorization notice (no stealth installation)
Write-Host @"
[NOTICE] This installer configures an authorized corporate administration service.
An authenticated organization administrator can run PowerShell commands and open an
interactive remote terminal on this computer. Commands run as a background service;
no terminal window opens on the desktop. All sessions and commands are audited.
Windows Defender, SmartScreen and event logging remain active and unmodified.
"@ -ForegroundColor Yellow

# 3. Resolve public anon key (never a service-role key)
if (-not $SupabaseAnonKey) {
    $shippedSettings = Join-Path $PSScriptRoot "appsettings.json"
    if (Test-Path $shippedSettings) {
        try {
            $shipped = Get-Content -Path $shippedSettings -Raw | ConvertFrom-Json
            $SupabaseAnonKey = $shipped.ScriptRunner.SupabaseAnonKey
        } catch {
            $SupabaseAnonKey = $null
        }
    }
}
if (-not $SupabaseAnonKey) {
    Write-Error "SupabaseAnonKey is required (public anon key). It must never be the service-role key."
    exit 1
}
if ($SupabaseAnonKey -match "service_role") {
    Write-Error "Refusing to install with a service-role key. Use the project's public anon key."
    exit 1
}

# 4. Create directories
Write-Host "[*] Creating target directories..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path (Split-Path $StateDir -Parent) "work") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path (Split-Path $StateDir -Parent) "packages") | Out-Null

# 5. Copy published binaries
$sourceDir = $PSScriptRoot
if (Test-Path (Join-Path $sourceDir "ScriptRunnerAgent.exe")) {
    Write-Host "[*] Copying agent binaries to $InstallDir..." -ForegroundColor Green
    Copy-Item -Path (Join-Path $sourceDir "*") -Destination $InstallDir -Recurse -Force
} elseif (Test-Path (Join-Path $sourceDir "..\publish\ScriptRunnerAgent.exe")) {
    Copy-Item -Path (Join-Path $sourceDir "..\publish\*") -Destination $InstallDir -Recurse -Force
} else {
    Write-Error "ScriptRunnerAgent.exe was not found next to this installer."
    exit 1
}

# 6. Preserve or reset device identity
if ($FreshIdentity -and (Test-Path $identityFile)) {
    Write-Host "[*] Removing previous device identity (fresh enrollment requested)..." -ForegroundColor Yellow
    Remove-Item -Path $identityFile -Force
}

# 7. Write configuration (device ID and device key are generated by the agent)
Write-Host "[*] Writing service configuration..." -ForegroundColor Green
$config = @{
    ScriptRunner = @{
        SupabaseUrl                     = $SupabaseUrl.TrimEnd('/')
        SupabaseAnonKey                 = $SupabaseAnonKey
        EnrollmentKey                   = $EnrollmentKey
        DeviceId                        = ""
        DeviceApiKey                    = ""
        PollIntervalSeconds             = 5
        MaxBackoffSeconds               = 60
        HeartbeatIntervalSeconds        = 30
        LocalStateDirectory             = $StateDir
        WorkingDirectory                = (Join-Path (Split-Path $StateDir -Parent) "work")
        MaxStdoutBytes                  = 65536
        MaxStderrBytes                  = 16384
        EnableRemoteTerminal            = $true
        TerminalClaimIntervalSeconds    = 2
        TerminalCommandTimeoutSeconds   = 300
        MaxTerminalCommandOutputChars   = 262144
        TerminalOutputBatchChars        = 4096
        EnableRmm                       = $true
        EventLogs                       = @("Application", "System")
        EnableSecurityEventLog          = $false
        MinimumEventLevel               = 3
        MaxEventsPerScan                = 200
        MaxPackageDownloadBytes         = 4294967296
        RequirePackageSignature         = $false
        DeploymentWorkingDirectory      = (Join-Path (Split-Path $StateDir -Parent) "packages")
        RmmStateDirectory               = $StateDir
    }
    Logging = @{
        LogLevel = @{
            Default                      = "Information"
            "Microsoft.Hosting.Lifetime" = "Information"
            "System.Net.Http.HttpClient" = "Warning"
        }
    }
} | ConvertTo-Json -Depth 5

$configFile = Join-Path $InstallDir "appsettings.json"
Set-Content -Path $configFile -Value $config -Encoding UTF8

# 8. Register the service first so the virtual service account SID exists
$binaryPath = Join-Path $InstallDir "ScriptRunnerAgent.exe"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "[*] Removing existing service registration..." -ForegroundColor Yellow
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 2
}

$accountArg = if ($ServiceAccount -eq "LocalSystem") { "LocalSystem" } else { "NT SERVICE\$serviceName" }
Write-Host "[*] Registering Windows Service '$serviceName' as $accountArg..." -ForegroundColor Green
$quotedBinary = "`"$binaryPath`""
& sc.exe create $serviceName binPath= $quotedBinary obj= $accountArg start= auto DisplayName= "ScriptRunner Authorized Agent" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create the Windows service (sc.exe exit $LASTEXITCODE)."
    exit 1
}
& sc.exe description $serviceName "Authorized corporate background execution agent for remote PowerShell administration." | Out-Null
& sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

# 9. Least-privilege ACLs (service account + SYSTEM + Administrators only)
Write-Host "[*] Applying restrictive NTFS permissions..." -ForegroundColor Green

$serviceSid = $null
if ($ServiceAccount -eq "VirtualServiceAccount") {
    & sc.exe sidtype $serviceName unrestricted | Out-Null
    $sidOutput = & sc.exe showsid $serviceName 2>$null
    if ($sidOutput -match "(S-1-5-80-\d+-\d+-\d+-\d+-\d+-\d+-\d+-\d+-\d+)") {
        $serviceSid = $Matches[1]
    } else {
        Write-Error "Could not resolve the virtual service account SID (sc.exe showsid $serviceName). Re-run the installer or use -ServiceAccount LocalSystem explicitly."
        exit 1
    }
}

function Set-RestrictedAcl {
    param([string]$Path, [string]$Sid, [bool]$ReadOnlyForUsers)

    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)

    $inheritance = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow

    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", $inheritance, $propagation, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("NT AUTHORITY\SYSTEM", "FullControl", $inheritance, $propagation, $allow)))

    if ($Sid) {
        $sidObj = New-Object System.Security.Principal.SecurityIdentifier($Sid)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sidObj, "FullControl", $inheritance, $propagation, $allow)))
    }

    if ($ReadOnlyForUsers) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Users", "ReadAndExecute", $inheritance, $propagation, $allow)))
    }

    Set-Acl -Path $Path -AclObject $acl
}

Set-RestrictedAcl -Path $InstallDir -Sid $serviceSid -ReadOnlyForUsers $true
Set-RestrictedAcl -Path $StateDir -Sid $serviceSid -ReadOnlyForUsers $false
Set-RestrictedAcl -Path (Join-Path (Split-Path $StateDir -Parent) "work") -Sid $serviceSid -ReadOnlyForUsers $false
Set-RestrictedAcl -Path (Join-Path (Split-Path $StateDir -Parent) "packages") -Sid $serviceSid -ReadOnlyForUsers $false

# Protect the configuration file (contains the organization enrollment key)
$configAcl = New-Object System.Security.AccessControl.FileSecurity
$configAcl.SetAccessRuleProtection($true, $false)
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("NT AUTHORITY\SYSTEM", "FullControl", "Allow")))
if ($serviceSid) {
    $sidObj = New-Object System.Security.Principal.SecurityIdentifier($serviceSid)
    $configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sidObj, "Read", "Allow")))
}
Set-Acl -Path $configFile -AclObject $configAcl

# 10. Start the service
Write-Host "[*] Starting $serviceName service..." -ForegroundColor Green
Start-Service -Name $serviceName
Start-Sleep -Seconds 3

$service = Get-Service -Name $serviceName
$serviceRunning = $service.Status -eq "Running"
$binaryPresent = Test-Path $binaryPath
$configPresent = Test-Path $configFile

if (-not ($serviceRunning -and $binaryPresent -and $configPresent)) {
    Write-Error "Installation checks failed: service=$($service.Status), binary=$binaryPresent, config=$configPresent. See the Application event log (Source: ScriptRunnerAgent)."
    exit 1
}

# 11. Report local success immediately; backend registration may still be retrying.
Write-Host ""
Write-Host "Installation successful" -ForegroundColor Green
Write-Host "  Service: $serviceName ($($service.Status))" -ForegroundColor Green
Write-Host "  Account: $accountArg" -ForegroundColor Green
Write-Host "  Host:    $([System.Net.Dns]::GetHostName())" -ForegroundColor Green
Write-Host "  Device identity: generated locally at $identityFile" -ForegroundColor Green

# 12. Wait briefly for the backend registration to complete (non-fatal)
Write-Host "[*] Waiting for automatic enrollment (no invitation token required)..." -ForegroundColor Green
$deadline = (Get-Date).AddSeconds(60)
$finalState = $null
while ((Get-Date) -lt $deadline) {
    if (Test-Path $statusFile) {
        try {
            $status = Get-Content -Path $statusFile -Raw | ConvertFrom-Json
            if ($status.state -eq "Authorized") {
                $finalState = $status
                break
            }
            if ($status.state -eq "AwaitingAuthorization") {
                $finalState = $status
                break
            }
        } catch { }
    }
    Start-Sleep -Seconds 2
}

if ($finalState) {
    Write-Host "[+] Device registered with the backend (device ID: $($finalState.device_id))." -ForegroundColor Green
    if ($finalState.state -eq "Authorized") {
        Write-Host "    It now appears automatically in Dashboard > Devices and can open a terminal." -ForegroundColor Green
    } else {
        Write-Host "    It appears in Dashboard > Devices awaiting administrator authorization." -ForegroundColor Yellow
        Write-Host "    No commands or terminal sessions are accepted until an administrator authorizes it." -ForegroundColor Yellow
    }
} else {
    Write-Host "[!] Local installation is complete, but backend registration has not been confirmed yet." -ForegroundColor Yellow
    Write-Host "    The service retries enrollment automatically (network outage, backend unavailable," -ForegroundColor Yellow
    Write-Host "    or pending administrator authorization). No invitation token is required." -ForegroundColor Yellow
    if (Test-Path $statusFile) {
        try {
            $status = Get-Content -Path $statusFile -Raw | ConvertFrom-Json
            Write-Host "    Current state: $($status.state) $($status.last_error)" -ForegroundColor Yellow
        } catch { }
    }
}

Write-Host ""
Write-Host "Local installation checks passed." -ForegroundColor Green
