"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Pause, Play, ShieldOff, Loader2 } from "lucide-react";
import type { EnrollmentStatus } from "@/types/database";
import { DeviceLifecycleModal, LifecycleAction } from "./DeviceLifecycleModal";

interface Props {
  deviceId: string;
  deviceName: string;
  status: EnrollmentStatus;
  hostname?: string | null;
  operatingSystem?: string | null;
  agentVersion?: string | null;
  onStatusChanged?: (newStatus: EnrollmentStatus) => void;
}

type Action = "authorize" | "suspend" | "resume" | "revoke";

export function DeviceStatusActions({
  deviceId,
  deviceName,
  status: initialStatus,
  hostname,
  operatingSystem,
  agentVersion,
  onStatusChanged,
}: Props) {
  const router = useRouter();
  const [currentStatus, setCurrentStatus] = useState<EnrollmentStatus>(initialStatus);
  const [modalAction, setModalAction] = useState<"revoke" | "suspend" | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleStatusUpdated = (newStatus: EnrollmentStatus) => {
    setCurrentStatus(newStatus);
    if (onStatusChanged) {
      onStatusChanged(newStatus);
    }
    router.refresh();
  };

  const runDirect = async (action: "authorize" | "resume") => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/devices/${deviceId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Action failed");
        return;
      }
      handleStatusUpdated("enrolled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
          {(currentStatus === "unauthorized" || currentStatus === "pending") && (
            <button
              onClick={() => void runDirect("authorize")}
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              title="Authorize device to execute jobs"
            >
              {busy === "authorize" ? (
                <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
              ) : (
                <CheckCircle2 style={{ width: 12, height: 12 }} />
              )}
              Authorize
            </button>
          )}

          {currentStatus === "enrolled" && (
            <button
              onClick={() => setModalAction("suspend")}
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              title="Temporarily suspend device"
              id={`suspend-device-${deviceId}`}
            >
              <Pause style={{ width: 12, height: 12 }} />
              Suspend
            </button>
          )}

          {currentStatus === "suspended" && (
            <button
              onClick={() => void runDirect("resume")}
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              title="Restore access for this device"
            >
              {busy === "resume" ? (
                <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
              ) : (
                <Play style={{ width: 12, height: 12 }} />
              )}
              Resume
            </button>
          )}

          {currentStatus !== "revoked" && (
            <button
              onClick={() => setModalAction("revoke")}
              className="btn btn-danger btn-sm"
              disabled={busy !== null}
              title="Revoke access permanently"
              id={`revoke-device-${deviceId}`}
            >
              <ShieldOff style={{ width: 12, height: 12 }} />
              Revoke
            </button>
          )}
        </div>

        {error && (
          <p style={{ fontSize: 11, color: "var(--status-error)", textAlign: "right", maxWidth: 240 }}>
            {error}
          </p>
        )}
      </div>

      {modalAction && (
        <DeviceLifecycleModal
          isOpen={modalAction !== null}
          onClose={() => setModalAction(null)}
          action={modalAction}
          deviceId={deviceId}
          deviceName={deviceName}
          hostname={hostname}
          operatingSystem={operatingSystem}
          agentVersion={agentVersion}
          currentStatus={currentStatus}
          onSuccess={handleStatusUpdated}
        />
      )}
    </>
  );
}
