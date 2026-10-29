"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldAlert,
  ShieldOff,
  PauseCircle,
  Monitor,
  AlertTriangle,
  X,
  Loader2,
  Copy,
  Check,
  Radio,
  FileText,
  RotateCcw,
} from "lucide-react";
import type { EnrollmentStatus } from "@/types/database";

export type LifecycleAction = "revoke" | "suspend" | "resume" | "authorize";

interface DeviceLifecycleModalProps {
  isOpen: boolean;
  onClose: () => void;
  action: LifecycleAction;
  deviceId: string;
  deviceName: string;
  hostname?: string | null;
  operatingSystem?: string | null;
  agentVersion?: string | null;
  currentStatus: EnrollmentStatus;
  onSuccess?: (newStatus: EnrollmentStatus) => void;
}

const PRESET_REVOKE_REASONS = [
  "Hardware Decommissioned",
  "Security Incident / Suspect",
  "Employee Offboarding",
  "Fresh Re-provisioning",
  "Device Replaced",
];

const PRESET_SUSPEND_REASONS = [
  "Scheduled Maintenance",
  "Investigation Pending",
  "Temporary Policy Hold",
  "Network Relocation",
];

export function DeviceLifecycleModal({
  isOpen,
  onClose,
  action,
  deviceId,
  deviceName,
  hostname,
  operatingSystem,
  agentVersion,
  currentStatus,
  onSuccess,
}: DeviceLifecycleModalProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  const isRevoke = action === "revoke";
  const isSuspend = action === "suspend";

  const handleCopyId = () => {
    navigator.clipboard.writeText(deviceId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/devices/${deviceId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          reason: reason.trim() || undefined,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Failed to ${action} device`);
      }

      const nextStatus: EnrollmentStatus =
        action === "revoke"
          ? "revoked"
          : action === "suspend"
          ? "suspended"
          : "enrolled";

      if (onSuccess) {
        onSuccess(nextStatus);
      }
      onClose();
    } catch (err: unknown) {
      console.error(`Error executing ${action} on device:`, err);
      setError(err instanceof Error ? err.message : "Failed to update device state");
    } finally {
      setBusy(false);
    }
  };

  const presetReasons = isRevoke ? PRESET_REVOKE_REASONS : PRESET_SUSPEND_REASONS;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
            background: "rgba(0, 0, 0, 0.8)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="card"
            style={{
              width: "100%",
              maxWidth: 520,
              padding: 0,
              background: "var(--bg-elevated)",
              border: isRevoke
                ? "1px solid rgba(244, 63, 94, 0.35)"
                : "1px solid rgba(251, 191, 36, 0.35)",
              boxShadow: isRevoke
                ? "0 24px 64px -12px rgba(244, 63, 94, 0.25), 0 0 0 1px rgba(244, 63, 94, 0.15)"
                : "0 24px 64px -12px rgba(251, 191, 36, 0.2), 0 0 0 1px rgba(251, 191, 36, 0.15)",
              overflow: "hidden",
            }}
          >
            {/* Top Glowing Header Accent */}
            <div
              style={{
                height: 4,
                width: "100%",
                background: isRevoke
                  ? "linear-gradient(90deg, #f43f5e 0%, #e11d48 50%, #fb7185 100%)"
                  : "linear-gradient(90deg, #fbbf24 0%, #f59e0b 50%, #fcd34d 100%)",
              }}
            />

            <div style={{ padding: "24px 28px" }}>
              {/* Header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 20,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: isRevoke
                        ? "rgba(244, 63, 94, 0.12)"
                        : "rgba(251, 191, 36, 0.12)",
                      border: isRevoke
                        ? "1px solid rgba(244, 63, 94, 0.28)"
                        : "1px solid rgba(251, 191, 36, 0.28)",
                      color: isRevoke ? "#f43f5e" : "#fbbf24",
                      flexShrink: 0,
                    }}
                  >
                    {isRevoke ? (
                      <ShieldAlert style={{ width: 22, height: 22 }} />
                    ) : (
                      <PauseCircle style={{ width: 22, height: 22 }} />
                    )}
                  </div>
                  <div>
                    <h2
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        letterSpacing: "-0.015em",
                        lineHeight: 1.2,
                        marginBottom: 4,
                      }}
                    >
                      {isRevoke ? "Revoke Device Access" : "Suspend Device"}
                    </h2>
                    <p
                      style={{
                        fontSize: 13,
                        color: "var(--text-secondary)",
                        lineHeight: 1.4,
                      }}
                    >
                      {isRevoke
                        ? "Permanently disconnect and invalidate credentials for this endpoint."
                        : "Temporarily pause command reception and terminal sessions."}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="btn-icon"
                  style={{ width: 30, height: 30, flexShrink: 0 }}
                  aria-label="Close dialog"
                >
                  <X style={{ width: 14, height: 14 }} />
                </button>
              </div>

              {/* Device Details Card */}
              <div
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  padding: "14px 16px",
                  marginBottom: 18,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Monitor
                      style={{
                        width: 16,
                        height: 16,
                        color: "var(--text-secondary)",
                      }}
                    />
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: "var(--text-primary)",
                      }}
                    >
                      {deviceName}
                    </span>
                    {hostname && hostname !== deviceName && (
                      <span
                        style={{
                          fontSize: 12,
                          fontFamily: "monospace",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--bg-overlay)",
                          color: "var(--text-secondary)",
                          border: "1px solid var(--border-subtle)",
                        }}
                      >
                        {hostname}
                      </span>
                    )}
                  </div>
                  <span
                    className="badge"
                    style={{
                      fontSize: 11,
                      textTransform: "capitalize",
                      color:
                        currentStatus === "enrolled"
                          ? "var(--status-online)"
                          : currentStatus === "suspended"
                          ? "var(--status-warning)"
                          : "var(--status-error)",
                      background:
                        currentStatus === "enrolled"
                          ? "rgba(52, 211, 153, 0.1)"
                          : currentStatus === "suspended"
                          ? "rgba(251, 191, 36, 0.1)"
                          : "rgba(244, 63, 94, 0.1)",
                      borderColor:
                        currentStatus === "enrolled"
                          ? "rgba(52, 211, 153, 0.25)"
                          : currentStatus === "suspended"
                          ? "rgba(251, 191, 36, 0.25)"
                          : "rgba(244, 63, 94, 0.25)",
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background:
                          currentStatus === "enrolled"
                            ? "var(--status-online)"
                            : currentStatus === "suspended"
                            ? "var(--status-warning)"
                            : "var(--status-error)",
                        marginRight: 4,
                      }}
                    />
                    {currentStatus}
                  </span>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    fontSize: 12,
                    borderTop: "1px solid var(--border-subtle)",
                    paddingTop: 8,
                  }}
                >
                  <div>
                    <span style={{ color: "var(--text-tertiary)" }}>OS: </span>
                    <span style={{ color: "var(--text-secondary)" }}>
                      {operatingSystem || "Windows"}
                    </span>
                  </div>
                  {agentVersion && (
                    <div>
                      <span style={{ color: "var(--text-tertiary)" }}>Agent: </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        v{agentVersion}
                      </span>
                    </div>
                  )}
                  <div
                    style={{
                      gridColumn: "1 / -1",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{ color: "var(--text-tertiary)" }}>Device ID: </span>
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                    >
                      {deviceId}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyId}
                      style={{
                        background: "none",
                        border: "none",
                        color: copiedId ? "var(--status-online)" : "var(--text-tertiary)",
                        cursor: "pointer",
                        padding: 2,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                      title="Copy full Device ID"
                    >
                      {copiedId ? (
                        <Check style={{ width: 12, height: 12 }} />
                      ) : (
                        <Copy style={{ width: 12, height: 12 }} />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Impact Breakdown */}
              <div
                style={{
                  background: isRevoke
                    ? "rgba(244, 63, 94, 0.06)"
                    : "rgba(251, 191, 36, 0.06)",
                  border: isRevoke
                    ? "1px solid rgba(244, 63, 94, 0.18)"
                    : "1px solid rgba(251, 191, 36, 0.18)",
                  borderRadius: "var(--radius-md)",
                  padding: "12px 14px",
                  fontSize: 12,
                  marginBottom: 18,
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    color: isRevoke ? "#fb7185" : "#fcd34d",
                    marginBottom: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <AlertTriangle style={{ width: 14, height: 14 }} />
                  {isRevoke ? "Immediate Security Effects:" : "Suspension Effects:"}
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    color: "var(--text-secondary)",
                  }}
                >
                  <li style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <span style={{ color: isRevoke ? "#f43f5e" : "#fbbf24" }}>•</span>
                    <span>
                      {isRevoke
                        ? "API token and credentials will be permanently invalidated."
                        : "Agent will be denied execution authorization until resumed."}
                    </span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <span style={{ color: isRevoke ? "#f43f5e" : "#fbbf24" }}>•</span>
                    <span>
                      All active remote terminal sessions on this PC are immediately terminated.
                    </span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <span style={{ color: isRevoke ? "#f43f5e" : "#fbbf24" }}>•</span>
                    <span>
                      Any in-flight or queued jobs for this device will be automatically cancelled.
                    </span>
                  </li>
                  {isRevoke && (
                    <li style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <span style={{ color: "#f43f5e" }}>•</span>
                      <span>
                        To reconnect this PC in the future, the agent will require a new provisioning token.
                      </span>
                    </li>
                  )}
                </ul>
              </div>

              {/* Reason Input & Quick Presets */}
              <div style={{ marginBottom: 20 }}>
                <label
                  htmlFor="lifecycle-reason-input"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                    marginBottom: 6,
                  }}
                >
                  <span>Reason for audit log (optional)</span>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    Stored in Audit Events
                  </span>
                </label>
                <input
                  id="lifecycle-reason-input"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={
                    isRevoke
                      ? "e.g., Decommissioned, Lost/Stolen, Replaced..."
                      : "e.g., Scheduled Maintenance, Policy Investigation..."
                  }
                  className="input"
                  disabled={busy}
                  style={{
                    width: "100%",
                    fontSize: 13,
                    height: 36,
                    background: "var(--bg-surface)",
                    borderColor: "var(--border-default)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                    padding: "0 10px",
                    marginBottom: 8,
                  }}
                />

                {/* Preset Chips */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {presetReasons.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setReason(preset)}
                      disabled={busy}
                      style={{
                        background:
                          reason === preset
                            ? "var(--bg-hover)"
                            : "var(--bg-surface)",
                        border:
                          reason === preset
                            ? "1px solid var(--border-strong)"
                            : "1px solid var(--border-subtle)",
                        color:
                          reason === preset
                            ? "var(--text-primary)"
                            : "var(--text-tertiary)",
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 6,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Error Banner */}
              {error && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "var(--radius-sm)",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    color: "var(--status-error)",
                    fontSize: 12,
                    marginBottom: 16,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}

              {/* Action Buttons */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 10,
                }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="btn btn-secondary"
                  style={{ minWidth: 90 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  id={`confirm-${action}-btn`}
                  onClick={handleConfirm}
                  disabled={busy}
                  className={isRevoke ? "btn btn-danger" : "btn btn-primary"}
                  style={{
                    minWidth: 150,
                    background: isRevoke ? "#e11d48" : "#f59e0b",
                    color: "#ffffff",
                    border: "none",
                    fontWeight: 600,
                  }}
                >
                  {busy ? (
                    <>
                      <Loader2
                        style={{ width: 14, height: 14 }}
                        className="animate-spin"
                      />
                      <span>Updating...</span>
                    </>
                  ) : isRevoke ? (
                    <>
                      <ShieldOff style={{ width: 14, height: 14 }} />
                      <span>Revoke Device Access</span>
                    </>
                  ) : (
                    <>
                      <PauseCircle style={{ width: 14, height: 14 }} />
                      <span>Suspend Device</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
