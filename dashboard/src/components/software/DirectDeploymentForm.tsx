"use client";

import React, { useState, useRef, useEffect, useTransition } from "react";
import {
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  X,
  Laptop,
  ChevronDown,
  ChevronUp,
  FileText,
  Clock,
  ShieldCheck,
  Check,
  RefreshCw,
  Rocket,
  Info,
} from "lucide-react";

export interface EnrolledDevice {
  id: string;
  hostname: string | null;
  display_name: string;
  operating_system: string | null;
  agent_version?: string | null;
  isOnline: boolean;
}

export interface DeploymentItem {
  id: string;
  package_name: string;
  version: string;
  package_format: string;
  file_name: string;
  file_size_bytes: number;
  sha256: string;
  device_id: string;
  device_hostname?: string;
  state: string;
  progress: number;
  exit_code?: number | null;
  output?: string | null;
  error_summary?: string | null;
  reboot_required?: boolean;
  created_at: string;
}

interface Props {
  devices: EnrolledDevice[];
  initialDeployments?: DeploymentItem[];
  preselectedDeviceId?: string;
}

export function DirectDeploymentForm({
  devices,
  initialDeployments = [],
  preselectedDeviceId,
}: Props) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string>("");
  const [fileFormat, setFileFormat] = useState<"msi" | "exe" | "msix" | "zip" | "unknown">("unknown");
  const [isComputingHash, setIsComputingHash] = useState(false);

  // Device selections
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>(() => {
    if (preselectedDeviceId) return [preselectedDeviceId];
    const online = devices.filter((d) => d.isOnline);
    return online.length > 0 ? [online[0].id] : devices.length > 0 ? [devices[0].id] : [];
  });

  // Advanced options (collapsed by default)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [packageName, setPackageName] = useState("");
  const [packageVersion, setPackageVersion] = useState("1.0.0");
  const [installArgs, setInstallArgs] = useState("");
  const [rebootPolicy, setRebootPolicy] = useState("never");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [detectionRule, setDetectionRule] = useState("");

  // Submitting state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Deployments tracking
  const [deployments, setDeployments] = useState<DeploymentItem[]>(initialDeployments);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Compute SHA-256 in browser on file selection
  const handleFileChange = async (file: File | null) => {
    if (!file) {
      setSelectedFile(null);
      setFileHash("");
      setFileFormat("unknown");
      return;
    }

    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (![".msi", ".exe", ".msix", ".zip"].includes(ext)) {
      setStatusMessage({
        type: "error",
        text: `Unsupported format "${ext}". Supported formats are .msi, .exe, .msix, and .zip.`,
      });
      return;
    }

    setStatusMessage(null);
    setSelectedFile(file);
    const fmt = ext === ".msi" ? "msi" : ext === ".msix" ? "msix" : ext === ".zip" ? "zip" : "exe";
    setFileFormat(fmt);

    // Pre-fill defaults
    const baseName = file.name.substring(0, file.name.lastIndexOf("."));
    setPackageName(baseName);
    if (fmt === "msi") {
      setInstallArgs("/qn /norestart");
    } else {
      setInstallArgs("");
    }

    setIsComputingHash(true);
    try {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      setFileHash(hashHex);
    } catch {
      setFileHash("");
    } finally {
      setIsComputingHash(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  const toggleDevice = (id: string) => {
    setSelectedDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAllOnline = () => {
    const onlineIds = devices.filter((d) => d.isOnline).map((d) => d.id);
    setSelectedDeviceIds(onlineIds);
  };

  const selectAll = () => {
    if (selectedDeviceIds.length === devices.length) {
      setSelectedDeviceIds([]);
    } else {
      setSelectedDeviceIds(devices.map((d) => d.id));
    }
  };

  // Submit Deployment
  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setStatusMessage({ type: "error", text: "Please select an installer file." });
      return;
    }
    if (selectedDeviceIds.length === 0) {
      setStatusMessage({ type: "error", text: "Please select at least one target device." });
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("device_ids", JSON.stringify(selectedDeviceIds));
    if (packageName) formData.append("name", packageName);
    if (packageVersion) formData.append("version", packageVersion);
    if (installArgs) formData.append("install_args", installArgs);
    formData.append("reboot_policy", rebootPolicy);
    formData.append("timeout_seconds", timeoutSeconds.toString());
    if (detectionRule) formData.append("detection_rule", detectionRule);

    try {
      const res = await fetch("/api/deployments/deploy", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setStatusMessage({ type: "error", text: data.error || "Deployment submission failed." });
      } else {
        setStatusMessage({
          type: "success",
          text: data.message || "Deployment initiated successfully!",
        });
        // Clear file input
        setSelectedFile(null);
        setFileHash("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        // Refresh deployments
        fetchDeployments();
      }
    } catch (err: any) {
      setStatusMessage({ type: "error", text: err.message || "Network error submitting deployment." });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Poll for deployment updates
  const fetchDeployments = async () => {
    try {
      const res = await fetch("/api/deployments/status");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.deployments)) {
          setDeployments(data.deployments);
        }
      }
    } catch {}
  };

  useEffect(() => {
    fetchDeployments();
    // Poll every 3 seconds while there are active deployments
    const interval = setInterval(() => {
      fetchDeployments();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = async (jobId: string) => {
    try {
      await fetch("/api/deployments/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", job_id: jobId }),
      });
      fetchDeployments();
    } catch {}
  };

  const handleRetry = async (jobId: string) => {
    try {
      await fetch("/api/deployments/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", job_id: jobId }),
      });
      fetchDeployments();
    } catch {}
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusBadge = (state: string, progress: number) => {
    switch (state) {
      case "queued":
      case "waiting_for_device":
        return (
          <span className="badge" style={{ background: "rgba(168,85,247,0.12)", color: "#c084fc", borderColor: "rgba(168,85,247,0.3)" }}>
            <Clock style={{ width: 12, height: 12, marginRight: 4 }} />
            Queued
          </span>
        );
      case "downloading":
        return (
          <span className="badge" style={{ background: "rgba(251,191,36,0.12)", color: "#fbbf24", borderColor: "rgba(251,191,36,0.3)" }}>
            <RefreshCw style={{ width: 12, height: 12, marginRight: 4, animation: "spin 2s linear infinite" }} />
            Downloading ({progress}%)
          </span>
        );
      case "validating":
        return (
          <span className="badge" style={{ background: "rgba(56,189,248,0.12)", color: "#38bdf8", borderColor: "rgba(56,189,248,0.3)" }}>
            <ShieldCheck style={{ width: 12, height: 12, marginRight: 4 }} />
            Validating ({progress}%)
          </span>
        );
      case "installing":
        return (
          <span className="badge" style={{ background: "rgba(96,165,250,0.15)", color: "#60a5fa", borderColor: "rgba(96,165,250,0.35)" }}>
            <RefreshCw style={{ width: 12, height: 12, marginRight: 4, animation: "spin 1.5s linear infinite" }} />
            Installing ({progress}%)
          </span>
        );
      case "verifying":
        return (
          <span className="badge" style={{ background: "rgba(192,132,252,0.15)", color: "#c084fc", borderColor: "rgba(192,132,252,0.35)" }}>
            <ShieldCheck style={{ width: 12, height: 12, marginRight: 4 }} />
            Verifying ({progress}%)
          </span>
        );
      case "succeeded":
        return (
          <span className="badge" style={{ background: "rgba(52,211,153,0.15)", color: "#34d399", borderColor: "rgba(52,211,153,0.35)" }}>
            <CheckCircle2 style={{ width: 12, height: 12, marginRight: 4 }} />
            Succeeded
          </span>
        );
      case "reboot_required":
        return (
          <span className="badge" style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", borderColor: "rgba(251,191,36,0.35)" }}>
            <AlertTriangle style={{ width: 12, height: 12, marginRight: 4 }} />
            Reboot Required
          </span>
        );
      case "cancelled":
        return (
          <span className="badge" style={{ background: "rgba(156,163,175,0.15)", color: "#9ca3af", borderColor: "rgba(156,163,175,0.3)" }}>
            <X style={{ width: 12, height: 12, marginRight: 4 }} />
            Cancelled
          </span>
        );
      case "failed":
      default:
        return (
          <span className="badge" style={{ background: "rgba(248,113,113,0.15)", color: "#f87171", borderColor: "rgba(248,113,113,0.35)" }}>
            <XCircle style={{ width: 12, height: 12, marginRight: 4 }} />
            Failed
          </span>
        );
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Status banner */}
      {statusMessage && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "var(--radius-md)",
            border: `1px solid ${statusMessage.type === "success" ? "rgba(52,211,153,0.3)" : "rgba(248,113,113,0.3)"}`,
            background: statusMessage.type === "success" ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)",
            color: statusMessage.type === "success" ? "#34d399" : "#f87171",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {statusMessage.type === "success" ? (
              <CheckCircle2 style={{ width: 16, height: 16 }} />
            ) : (
              <AlertTriangle style={{ width: 16, height: 16 }} />
            )}
            <span>{statusMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}

      {/* Main Single-Step Installation Card */}
      <form onSubmit={handleDeploy} className="card" style={{ padding: "24px 28px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "rgba(59,130,246,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#60a5fa",
            }}
          >
            <Upload style={{ width: 18, height: 18 }} />
          </div>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Remote Software Installation</h2>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "2px 0 0" }}>
              Upload any MSI or EXE installer and deploy it silently to your Windows devices.
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
          {/* 1. Drag & Drop Upload Zone */}
          <div>
            <label className="label" style={{ fontWeight: 600, marginBottom: 8, display: "block" }}>
              1. Choose Installer Binary
            </label>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: "2px dashed var(--border-default)",
                borderRadius: "var(--radius-lg)",
                padding: "24px 20px",
                textAlign: "center",
                cursor: "pointer",
                background: selectedFile ? "rgba(59,130,246,0.03)" : "var(--bg-base)",
                transition: "border-color 0.2s, background 0.2s",
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".msi,.exe,.msix,.zip"
                style={{ display: "none" }}
                onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
              />

              {!selectedFile ? (
                <div>
                  <Upload style={{ width: 32, height: 32, color: "var(--text-tertiary)", margin: "0 auto 8px" }} />
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    Drag and drop installer file here, or click to browse
                  </p>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                    Supports Windows Installer (<span style={{ color: "#60a5fa", fontFamily: "monospace" }}>.MSI</span>) and Executables (<span style={{ color: "#34d399", fontFamily: "monospace" }}>.EXE</span>)
                  </p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <FileText style={{ width: 22, height: 22, color: "#60a5fa" }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                      {selectedFile.name}
                    </span>
                    <span className="badge" style={{ textTransform: "uppercase", fontSize: 10 }}>
                      {fileFormat}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      ({formatBytes(selectedFile.size)})
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleFileChange(null);
                      }}
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "2px 6px", height: "auto" }}
                    >
                      <X style={{ width: 14, height: 14 }} />
                    </button>
                  </div>

                  {isComputingHash ? (
                    <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Computing SHA-256 hash...</p>
                  ) : fileHash ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
                      <Check style={{ width: 12, height: 12, color: "#34d399" }} />
                      <span>SHA-256: {fileHash.slice(0, 16)}...{fileHash.slice(-12)}</span>
                    </div>
                  ) : null}

                  {fileFormat === "msi" && (
                    <p style={{ fontSize: 11, color: "#34d399", marginTop: 4 }}>
                      ✓ Standard silent flags (/qn /norestart) configured automatically
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 2. Target Device Selection */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <label className="label" style={{ fontWeight: 600, margin: 0 }}>
                2. Select Target Windows Device(s)
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={selectAllOnline}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: "2px 8px", height: "auto" }}
                >
                  Select Online ({devices.filter((d) => d.isOnline).length})
                </button>
                <button
                  type="button"
                  onClick={selectAll}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: "2px 8px", height: "auto" }}
                >
                  {selectedDeviceIds.length === devices.length ? "Deselect All" : "Select All"}
                </button>
              </div>
            </div>

            <div
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-base)",
                maxHeight: 220,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {devices.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
                  No enrolled devices found in organization.
                </div>
              ) : (
                devices.map((device) => {
                  const isChecked = selectedDeviceIds.includes(device.id);
                  return (
                    <label
                      key={device.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        borderBottom: "1px solid var(--border-subtle)",
                        cursor: "pointer",
                        background: isChecked ? "rgba(59,130,246,0.06)" : "transparent",
                        transition: "background 0.15s",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleDevice(device.id)}
                        style={{ width: 16, height: 16, accentColor: "#3b82f6" }}
                      />
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: device.isOnline ? "#34d399" : "#64748b",
                            boxShadow: device.isOnline ? "0 0 6px #34d399" : "none",
                          }}
                        />
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                          {device.hostname || device.display_name}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
                          {device.operating_system || "Windows"}
                        </span>
                      </div>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {device.isOnline ? "Online" : "Offline"}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
              {selectedDeviceIds.length} of {devices.length} device(s) selected
            </p>
          </div>

          {/* 3. Collapsible Advanced Options */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: "6px 0",
              }}
            >
              {showAdvanced ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />}
              Advanced Options (Installation Flags, Timeout, Reboot Policy)
            </button>

            {showAdvanced && (
              <div
                style={{
                  marginTop: 10,
                  padding: "16px 20px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-overlay)",
                  border: "1px solid var(--border-default)",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 14,
                }}
              >
                <div>
                  <label className="label" htmlFor="custom-pkg-name">Package Name</label>
                  <input
                    id="custom-pkg-name"
                    value={packageName}
                    onChange={(e) => setPackageName(e.target.value)}
                    className="input"
                    placeholder="e.g. 7-Zip, Google Chrome"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="custom-pkg-version">Version</label>
                  <input
                    id="custom-pkg-version"
                    value={packageVersion}
                    onChange={(e) => setPackageVersion(e.target.value)}
                    className="input"
                    placeholder="1.0.0"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="custom-args">Silent Install Arguments</label>
                  <input
                    id="custom-args"
                    value={installArgs}
                    onChange={(e) => setInstallArgs(e.target.value)}
                    className="input"
                    placeholder={fileFormat === "msi" ? "/qn /norestart" : "/S or /silent"}
                  />
                  <p style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
                    MSI default is <span style={{ fontFamily: "monospace" }}>/qn /norestart</span>.
                  </p>
                </div>

                <div>
                  <label className="label" htmlFor="custom-reboot">Reboot Policy</label>
                  <select
                    id="custom-reboot"
                    value={rebootPolicy}
                    onChange={(e) => setRebootPolicy(e.target.value)}
                    className="select"
                  >
                    <option value="never">Do not restart (Never)</option>
                    <option value="if_required">Restart only if installer requires (3010/1641)</option>
                    <option value="always">Always restart after installation</option>
                  </select>
                </div>

                <div>
                  <label className="label" htmlFor="custom-timeout">Timeout (Seconds)</label>
                  <input
                    id="custom-timeout"
                    type="number"
                    min={30}
                    max={3600}
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 600)}
                    className="input"
                  />
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label" htmlFor="custom-detection">
                    Custom Verification Rule (Optional JSON)
                  </label>
                  <input
                    id="custom-detection"
                    value={detectionRule}
                    onChange={(e) => setDetectionRule(e.target.value)}
                    className="input"
                    placeholder='Leave empty for automatic detection, or e.g. {"type":"msi_product_code","value":"{GUID}"}'
                    style={{ fontFamily: "monospace", fontSize: 11.5 }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 4. Action Button */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
            <button
              type="submit"
              disabled={isSubmitting || !selectedFile || selectedDeviceIds.length === 0}
              className="btn btn-primary"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 24px",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />
                  Deploying to {selectedDeviceIds.length} Device(s)...
                </>
              ) : (
                <>
                  <Rocket style={{ width: 16, height: 16 }} />
                  Install on {selectedDeviceIds.length} Selected Device(s)
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Deployment History & Real-Time Status Card */}
      <div className="card" style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Laptop style={{ width: 18, height: 18, color: "var(--text-secondary)" }} />
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Deployment Activity & Results</h3>
          </div>
          <button
            type="button"
            onClick={fetchDeployments}
            className="btn btn-ghost btn-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}
          >
            <RefreshCw style={{ width: 12, height: 12 }} />
            Refresh
          </button>
        </div>

        {deployments.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)" }}>
            <Info style={{ width: 28, height: 28, margin: "0 auto 8px", opacity: 0.5 }} />
            <p style={{ fontSize: 13, fontWeight: 500 }}>No software deployments have been initiated yet.</p>
            <p style={{ fontSize: 11, marginTop: 4 }}>Select an installer above to launch your first remote deployment.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-default)", textAlign: "left" }}>
                  <th style={{ padding: "10px 12px", color: "var(--text-tertiary)", fontWeight: 600 }}>Package / Version</th>
                  <th style={{ padding: "10px 12px", color: "var(--text-tertiary)", fontWeight: 600 }}>Target Device</th>
                  <th style={{ padding: "10px 12px", color: "var(--text-tertiary)", fontWeight: 600 }}>Status</th>
                  <th style={{ padding: "10px 12px", color: "var(--text-tertiary)", fontWeight: 600 }}>Initiated</th>
                  <th style={{ padding: "10px 12px", color: "var(--text-tertiary)", fontWeight: 600, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((job) => {
                  const isLogExpanded = expandedLogId === job.id;
                  return (
                    <React.Fragment key={job.id}>
                      <tr
                        style={{
                          borderBottom: "1px solid var(--border-subtle)",
                          background: isLogExpanded ? "rgba(255,255,255,0.02)" : "transparent",
                        }}
                      >
                        <td style={{ padding: "12px" }}>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{job.package_name}</div>
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
                            v{job.version} · {job.file_name} ({formatBytes(job.file_size_bytes)})
                          </div>
                        </td>
                        <td style={{ padding: "12px" }}>
                          <span style={{ fontWeight: 500 }}>{job.device_hostname || "Windows Host"}</span>
                        </td>
                        <td style={{ padding: "12px" }}>
                          {getStatusBadge(job.state, job.progress)}
                        </td>
                        <td style={{ padding: "12px", color: "var(--text-tertiary)", fontSize: 11 }}>
                          {new Date(job.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </td>
                        <td style={{ padding: "12px", textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            {job.output && (
                              <button
                                type="button"
                                onClick={() => setExpandedLogId(isLogExpanded ? null : job.id)}
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                              >
                                {isLogExpanded ? "Hide Logs" : "View Logs"}
                              </button>
                            )}

                            {job.state === "failed" && (
                              <button
                                type="button"
                                onClick={() => handleRetry(job.id)}
                                className="btn btn-secondary btn-sm"
                                style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                                title="Retry deployment"
                              >
                                <RotateCcw style={{ width: 11, height: 11, marginRight: 4 }} />
                                Retry
                              </button>
                            )}

                            {(job.state === "queued" || job.state === "waiting_for_device") && (
                              <button
                                type="button"
                                onClick={() => handleCancel(job.id)}
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: 11, padding: "3px 8px", height: "auto", color: "#f87171" }}
                                title="Cancel deployment"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expandable output & log viewer */}
                      {isLogExpanded && (
                        <tr>
                          <td colSpan={5} style={{ padding: "12px 16px", background: "rgba(0,0,0,0.25)", borderBottom: "1px solid var(--border-subtle)" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-tertiary)" }}>
                                <span>Exit code: <strong style={{ color: "var(--text-primary)" }}>{job.exit_code ?? "N/A"}</strong></span>
                                <span>SHA-256: <code style={{ fontSize: 10 }}>{job.sha256}</code></span>
                              </div>
                              {job.error_summary && (
                                <div style={{ color: "#f87171", fontSize: 11, fontWeight: 500 }}>
                                  Error: {job.error_summary}
                                </div>
                              )}
                              <pre
                                style={{
                                  background: "#090d16",
                                  padding: 12,
                                  borderRadius: 6,
                                  fontSize: 11,
                                  fontFamily: "monospace",
                                  maxHeight: 200,
                                  overflowY: "auto",
                                  whiteSpace: "pre-wrap",
                                  color: "#e2e8f0",
                                  margin: 0,
                                }}
                              >
                                {job.output || "No output recorded."}
                              </pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
