import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type DeploymentState =
  | "queued"
  | "waiting_for_device"
  | "downloading"
  | "validating"
  | "installing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "reboot_required";

export interface DetectionRule {
  type: "msi_product_code" | "registry_value" | "file_exists" | "file_version" | "service_exists" | "process_running";
  value?: string;
  path?: string;
  name?: string;
  min_version?: string;
}

export interface DeploymentJobRecord {
  id: string;
  package_id: string;
  package_version_id: string;
  package_name: string;
  package_format: "msi" | "exe" | "msix" | "zip";
  version: string;
  file_name: string;
  file_size_bytes: number;
  sha256: string;
  storage_path: string;
  device_id: string;
  device_hostname?: string;
  organization_id: string;
  operation: "install" | "uninstall" | "repair";
  install_args?: string;
  uninstall_args?: string;
  repair_args?: string;
  detection_rules: DetectionRule | Record<string, unknown>;
  requires_reboot: boolean;
  timeout_seconds: number;
  state: DeploymentState;
  progress: number;
  attempts: number;
  max_attempts: number;
  exit_code?: number | null;
  output?: string | null;
  error_summary?: string | null;
  reboot_required?: boolean;
  download_token: string;
  requested_by?: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
}

const DATA_ROOT = path.join(process.cwd(), "data");
const PACKAGES_DIR = path.join(DATA_ROOT, "packages");
const DEPLOYMENTS_FILE = path.join(DATA_ROOT, "deployments.json");

function ensureDirs() {
  if (!fsSync.existsSync(PACKAGES_DIR)) {
    fsSync.mkdirSync(PACKAGES_DIR, { recursive: true });
  }
}

async function loadDeployments(): Promise<DeploymentJobRecord[]> {
  ensureDirs();
  try {
    const raw = await fs.readFile(DEPLOYMENTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveDeployments(list: DeploymentJobRecord[]): Promise<void> {
  ensureDirs();
  await fs.writeFile(DEPLOYMENTS_FILE, JSON.stringify(list, null, 2), "utf8");
}

/**
 * Extracts metadata and ProductCode from an MSI installer using Windows COM Installer API via PowerShell.
 */
export async function extractMsiMetadata(filePath: string): Promise<{
  productCode?: string;
  productName?: string;
  productVersion?: string;
  manufacturer?: string;
}> {
  try {
    const psScript = `
      $path = [System.IO.Path]::GetFullPath("${filePath.replace(/\\/g, "\\\\")}")
      try {
        $com = New-Object -ComObject WindowsInstaller.Installer
        $db = $com.GetType().InvokeMember("OpenDatabase", "InvokeMethod", $null, $com, @($path, 0))
        $view = $db.GetType().InvokeMember("OpenView", "InvokeMethod", $null, $db, @("SELECT Property, Value FROM Property"))
        $view.GetType().InvokeMember("Execute", "InvokeMethod", $null, $view, $null)
        $p = @{}
        while ($true) {
          $rec = $view.GetType().InvokeMember("Fetch", "InvokeMethod", $null, $view, $null)
          if ($null -eq $rec) { break }
          $k = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(1))
          $v = $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, @(2))
          $p[$k] = $v
        }
        [ordered]@{
          productCode = $p["ProductCode"]
          productName = $p["ProductName"]
          productVersion = $p["ProductVersion"]
          manufacturer = $p["Manufacturer"]
        } | ConvertTo-Json -Compress
      } catch {
        "{}"
      }
    `;

    const tmpPs = path.join(os.tmpdir(), `msi_inspect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
    await fs.writeFile(tmpPs, psScript, "utf8");
    try {
      const { stdout } = await execAsync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmpPs}"`, {
        timeout: 10000,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout.trim() || "{}");
      return parsed;
    } finally {
      await fs.unlink(tmpPs).catch(() => {});
    }
  } catch (err) {
    console.warn("Failed to inspect MSI with COM object:", err);
    return {};
  }
}

/**
 * Extracts version info from an EXE binary.
 */
export async function extractExeMetadata(filePath: string): Promise<{
  productName?: string;
  productVersion?: string;
  companyName?: string;
}> {
  try {
    const psScript = `
      $path = [System.IO.Path]::GetFullPath("${filePath.replace(/\\/g, "\\\\")}")
      try {
        $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
        [ordered]@{
          productName = if ($info.ProductName) { $info.ProductName } else { $info.FileDescription }
          productVersion = if ($info.ProductVersion) { $info.ProductVersion } else { $info.FileVersion }
          companyName = $info.CompanyName
        } | ConvertTo-Json -Compress
      } catch {
        "{}"
      }
    `;

    const tmpPs = path.join(os.tmpdir(), `exe_inspect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
    await fs.writeFile(tmpPs, psScript, "utf8");
    try {
      const { stdout } = await execAsync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmpPs}"`, {
        timeout: 10000,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout.trim() || "{}");
      return parsed;
    } finally {
      await fs.unlink(tmpPs).catch(() => {});
    }
  } catch {
    return {};
  }
}

export interface PublishPackageOptions {
  name?: string;
  version?: string;
  installArgs?: string;
  uninstallArgs?: string;
  detectionRule?: DetectionRule;
  requiresReboot?: boolean;
  timeoutSeconds?: number;
}

export async function storePackageFile(
  fileBuffer: Buffer,
  originalFilename: string,
  options: PublishPackageOptions = {}
): Promise<{
  packageId: string;
  packageName: string;
  packageFormat: "msi" | "exe" | "msix" | "zip";
  version: string;
  fileSizeBytes: number;
  sha256: string;
  storagePath: string;
  installArgs: string;
  uninstallArgs?: string;
  detectionRule: DetectionRule;
  requiresReboot: boolean;
}> {
  ensureDirs();

  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const ext = path.extname(originalFilename).toLowerCase();
  const format: "msi" | "exe" | "msix" | "zip" =
    ext === ".msi" ? "msi" : ext === ".msix" ? "msix" : ext === ".zip" ? "zip" : "exe";

  const packageId = crypto.randomUUID();
  const storedFilename = `${packageId}${ext}`;
  const localFilePath = path.join(PACKAGES_DIR, storedFilename);

  await fs.writeFile(localFilePath, fileBuffer);

  let detectedName: string | undefined;
  let detectedVersion: string | undefined;
  let autoDetectionRule: DetectionRule = { type: "file_exists", path: "" };

  if (format === "msi") {
    const meta = await extractMsiMetadata(localFilePath);
    detectedName = meta.productName;
    detectedVersion = meta.productVersion;
    if (meta.productCode) {
      autoDetectionRule = {
        type: "msi_product_code",
        value: meta.productCode,
      };
    }
  } else if (format === "exe") {
    const meta = await extractExeMetadata(localFilePath);
    detectedName = meta.productName;
    detectedVersion = meta.productVersion;
  }

  const baseNameWithoutExt = path.basename(originalFilename, ext);
  const finalName = options.name?.trim() || detectedName?.trim() || baseNameWithoutExt || "Software Package";
  const finalVersion = options.version?.trim() || detectedVersion?.trim() || "1.0.0";

  // Safe install argument defaults
  let finalInstallArgs = options.installArgs?.trim();
  if (!finalInstallArgs) {
    if (format === "msi") {
      finalInstallArgs = "/qn /norestart";
    } else {
      finalInstallArgs = "";
    }
  }

  // Final detection rule
  const finalDetectionRule = options.detectionRule || autoDetectionRule;
  if (!finalDetectionRule.value && !finalDetectionRule.path) {
    // If no specific rule could be determined, fallback to registry uninstall check for the name
    finalDetectionRule.type = "registry_value";
    finalDetectionRule.path = `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${finalName}`;
    finalDetectionRule.name = "DisplayName";
  }

  return {
    packageId,
    packageName: finalName,
    packageFormat: format,
    version: finalVersion,
    fileSizeBytes: fileBuffer.length,
    sha256,
    storagePath: storedFilename,
    installArgs: finalInstallArgs,
    uninstallArgs: options.uninstallArgs || (format === "msi" ? "/qn /norestart" : undefined),
    detectionRule: finalDetectionRule,
    requiresReboot: options.requiresReboot || false,
  };
}

export async function createDeployments(
  pkg: {
    packageId: string;
    packageName: string;
    packageFormat: "msi" | "exe" | "msix" | "zip";
    version: string;
    fileSizeBytes: number;
    sha256: string;
    storagePath: string;
    installArgs: string;
    uninstallArgs?: string;
    repairArgs?: string;
    detectionRule: DetectionRule;
    requiresReboot: boolean;
    timeoutSeconds?: number;
  },
  targets: Array<{ deviceId: string; hostname?: string }>,
  organizationId: string,
  requestedBy?: string
): Promise<DeploymentJobRecord[]> {
  const deployments = await loadDeployments();
  const created: DeploymentJobRecord[] = [];

  for (const target of targets) {
    const job: DeploymentJobRecord = {
      id: crypto.randomUUID(),
      package_id: pkg.packageId,
      package_version_id: pkg.packageId,
      package_name: pkg.packageName,
      package_format: pkg.packageFormat,
      version: pkg.version,
      file_name: path.basename(pkg.storagePath),
      file_size_bytes: pkg.fileSizeBytes,
      sha256: pkg.sha256,
      storage_path: pkg.storagePath,
      device_id: target.deviceId,
      device_hostname: target.hostname || "Windows Host",
      organization_id: organizationId,
      operation: "install",
      install_args: pkg.installArgs,
      uninstall_args: pkg.uninstallArgs,
      repair_args: pkg.repairArgs,
      detection_rules: pkg.detectionRule,
      requires_reboot: pkg.requiresReboot,
      timeout_seconds: pkg.timeoutSeconds || 600,
      state: "queued",
      progress: 0,
      attempts: 0,
      max_attempts: 2,
      exit_code: null,
      output: null,
      error_summary: null,
      reboot_required: false,
      download_token: crypto.randomBytes(24).toString("hex"),
      requested_by: requestedBy,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    deployments.unshift(job);
    created.push(job);
  }

  await saveDeployments(deployments);
  return created;
}

export async function getPendingDeploymentsCount(deviceId: string): Promise<number> {
  const list = await loadDeployments();
  return list.filter((j) => j.device_id === deviceId && (j.state === "queued" || j.state === "waiting_for_device")).length;
}

export async function claimNextDeployment(deviceId: string, baseUrl = "http://localhost:3000"): Promise<any | null> {
  const list = await loadDeployments();
  const index = list.findIndex((j) => j.device_id === deviceId && (j.state === "queued" || j.state === "waiting_for_device"));
  if (index === -1) return null;

  const job = list[index];
  job.attempts += 1;
  job.state = "downloading";
  job.progress = 20;
  job.started_at = job.started_at || new Date().toISOString();
  job.updated_at = new Date().toISOString();

  await saveDeployments(list);

  const downloadUrl = `${baseUrl}/api/packages/download/${job.package_id}?token=${job.download_token}`;

  return {
    job_id: job.id,
    package_version_id: job.package_version_id,
    operation: job.operation,
    attempt_number: job.attempts,
    package_name: job.package_name,
    package_format: job.package_format,
    version: job.version,
    storage_path: job.storage_path,
    sha256: job.sha256,
    file_size_bytes: job.file_size_bytes,
    install_args: job.install_args,
    uninstall_args: job.uninstall_args,
    repair_args: job.repair_args,
    detection_rules: job.detection_rules,
    prerequisites: [],
    signature_subject: null,
    requires_reboot: job.requires_reboot,
    timeout_seconds: job.timeout_seconds,
    download_url: downloadUrl,
  };
}

export async function updateDeploymentProgress(
  jobId: string,
  update: {
    state?: DeploymentState;
    progress?: number | null;
    exit_code?: number | null;
    output?: string | null;
    error?: string | null;
    reboot_required?: boolean | null;
  }
): Promise<DeploymentJobRecord | null> {
  const list = await loadDeployments();
  const job = list.find((j) => j.id === jobId);
  if (!job) return null;

  if (update.state) job.state = update.state;
  if (typeof update.progress === "number") job.progress = update.progress;
  if (update.exit_code !== undefined) job.exit_code = update.exit_code;
  if (update.output) job.output = update.output;
  if (update.error) job.error_summary = update.error;
  if (typeof update.reboot_required === "boolean") job.reboot_required = update.reboot_required;

  if (job.state === "succeeded" || job.state === "failed" || job.state === "reboot_required" || job.state === "cancelled") {
    job.completed_at = new Date().toISOString();
  }
  job.updated_at = new Date().toISOString();

  await saveDeployments(list);
  return job;
}

export async function cancelDeployment(jobId: string): Promise<boolean> {
  const list = await loadDeployments();
  const job = list.find((j) => j.id === jobId);
  if (!job) return false;
  if (job.state === "succeeded" || job.state === "failed") return false;

  job.state = "cancelled";
  job.completed_at = new Date().toISOString();
  job.updated_at = new Date().toISOString();
  job.error_summary = "Cancelled by administrator";

  await saveDeployments(list);
  return true;
}

export async function retryDeployment(jobId: string): Promise<boolean> {
  const list = await loadDeployments();
  const job = list.find((j) => j.id === jobId);
  if (!job) return false;

  job.state = "queued";
  job.progress = 0;
  job.exit_code = null;
  job.output = null;
  job.error_summary = null;
  job.reboot_required = false;
  job.started_at = null;
  job.completed_at = null;
  job.updated_at = new Date().toISOString();

  await saveDeployments(list);
  return true;
}

export async function getPackageFilePath(storagePath: string): Promise<string | null> {
  const full = path.join(PACKAGES_DIR, path.basename(storagePath));
  if (fsSync.existsSync(full)) {
    return full;
  }
  return null;
}

export async function getAllDeployments(): Promise<DeploymentJobRecord[]> {
  return await loadDeployments();
}

export async function getDeploymentById(id: string): Promise<DeploymentJobRecord | null> {
  const list = await loadDeployments();
  return list.find((j) => j.id === id) || null;
}
