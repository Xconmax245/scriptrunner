"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Pause, Play, ShieldOff, Loader2 } from "lucide-react";
import type { EnrollmentStatus } from "@/types/database";

interface Props {
  deviceId: string;
  deviceName: string;
  status: EnrollmentStatus;
}

type Action = "authorize" | "suspend" | "resume" | "revoke";

export function DeviceStatusActions({ deviceId, deviceName, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Action) => {
    if (action === "revoke" && !window.confirm(
      `Revoke ${deviceName}? Its terminal sessions stop immediately and it can no longer receive commands.`
    )) {
      return;
    }
    if (action === "suspend" && !window.confirm(
      `Suspend ${deviceName}? Live terminal sessions are terminated and queued jobs are cancelled.`
    )) {
      return;
    }

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
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        {(status === "unauthorized" || status === "pending") && (
          <button
            onClick={() => void run("authorize")}
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            title="Authorize device to execute jobs"
          >
            {busy === "authorize" ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <CheckCircle2 style={{ width: 12, height: 12 }} />}
            Authorize
          </button>
        )}

        {status === "enrolled" && (
          <button
            onClick={() => void run("suspend")}
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            title="Temporarily suspend device"
          >
            {busy === "suspend" ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Pause style={{ width: 12, height: 12 }} />}
            Suspend
          </button>
        )}

        {status === "suspended" && (
          <button
            onClick={() => void run("resume")}
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            title="Restore access for this device"
          >
            {busy === "resume" ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Play style={{ width: 12, height: 12 }} />}
            Resume
          </button>
        )}

        {status !== "revoked" && (
          <button
            onClick={() => void run("revoke")}
            className="btn btn-danger btn-sm"
            disabled={busy !== null}
            title="Revoke access permanently"
          >
            {busy === "revoke" ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <ShieldOff style={{ width: 12, height: 12 }} />}
            Revoke
          </button>
        )}
      </div>

      {error && <p style={{ fontSize: 11, color: "var(--status-error)", textAlign: "right", maxWidth: 220 }}>{error}</p>}
    </div>
  );
}
