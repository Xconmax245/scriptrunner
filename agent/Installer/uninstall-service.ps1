<#
.SYNOPSIS
    ScriptRunner Authorized Windows Agent Uninstaller
.DESCRIPTION
    Stops and removes the ScriptRunner Windows Service and cleans up installed files.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\ScriptRunnerAgent",
    [string]$StateDir = "$env:ProgramData\ScriptRunnerAgent"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ScriptRunner Windows Agent Removal" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Require Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Administrator privileges are required to uninstall the ScriptRunner Windows Service."
    exit 1
}

$serviceName = "ScriptRunnerAgent"
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($service) {
    Write-Host "[*] Stopping $serviceName service..." -ForegroundColor Yellow
    if ($service.Status -ne "Stopped") {
        Stop-Service -Name $serviceName -Force
        Start-Sleep -Seconds 2
    }

    Write-Host "[*] Deleting service registration..." -ForegroundColor Yellow
    & sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 2
} else {
    Write-Host "[!] Service $serviceName is not registered." -ForegroundColor Yellow
}

# Remove directories
if (Test-Path $InstallDir) {
    Write-Host "[*] Removing binaries from $InstallDir..." -ForegroundColor Yellow
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path $StateDir) {
    Write-Host "[*] Removing state data from $StateDir..." -ForegroundColor Yellow
    Remove-Item -Path $StateDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[+] ScriptRunner Agent successfully uninstalled." -ForegroundColor Green
