"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { z } from "zod";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Play,
  Loader2,
  AlertCircle,
  Monitor,
  Clock,
  FileCode,
  Info,
  ShieldCheck,
  X,
  Terminal,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { WorkingTerminal } from "@/components/terminal/WorkingTerminal";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 320,
        background: "var(--bg-overlay)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <Loader2 style={{ width: 18, height: 18, color: "var(--text-tertiary)" }} className="animate-spin" />
    </div>
  ),
});

const schema = z.object({
  device_id: z.string().uuid("Please select a device"),
  script_content: z.string().min(1, "Script cannot be empty"),
  description: z.string().max(500).optional(),
  change_ticket: z.string().max(100).optional(),
  timeout_seconds: z.coerce.number().int().min(1).max(86400),
  expires_in_seconds: z.coerce.number().int().min(60).max(604800),
  confirm: z.boolean().refine((val) => val === true, { message: "You must confirm authorization before submitting" }),
});

type FormValues = z.infer<typeof schema>;

interface Device {
  id: string;
  display_name: string;
  hostname: string | null;
  operating_system: string | null;
  last_seen_at: string | null;
  isOnline?: boolean;
}

interface Props {
  organizationId: string;
  devices: Device[];
  defaultTimeout: number;
  defaultExpirySeconds: number;
  maxScriptBytes: number;
}

const DEFAULT_SCRIPT = `# PowerShell script execution
# Target runs securely under authorized service credentials.
Write-Host "Target Node Hostname: $env:COMPUTERNAME"
Write-Host "Execution Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Get-Service -Name ScriptRunnerAgent | Select-Object Name, Status, StartType
`;

export function NewJobForm({
  organizationId,
  devices,
  defaultTimeout,
  defaultExpirySeconds,
  maxScriptBytes,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [scriptBytes, setScriptBytes] = useState(0);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema) as any,
    defaultValues: {
      script_content: DEFAULT_SCRIPT,
      timeout_seconds: defaultTimeout,
      expires_in_seconds: defaultExpirySeconds,
    },
  });

  const watchedDeviceId = watch("device_id");
  const selectedDevice = devices.find((d) => d.id === watchedDeviceId);

  const handleScriptChange = useCallback((value: string | undefined) => {
    const bytes = new TextEncoder().encode(value ?? "").length;
    setScriptBytes(bytes);
  }, []);

  const onValidSubmit = (values: FormValues) => {
    setPendingValues(values);
    setShowConfirmModal(true);
  };

  const executeSubmit = async () => {
    if (!pendingValues) return;
    setSubmitting(true);
    setError(null);
    setShowConfirmModal(false);

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          ...pendingValues,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to submit job");
        return;
      }

      router.push(`/dashboard/jobs/${data.job_id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const [mode, setMode] = useState<"terminal" | "script">("terminal");

  const bytesPct = Math.min((scriptBytes / maxScriptBytes) * 100, 100);
  const bytesOverLimit = scriptBytes > maxScriptBytes;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Mode Switcher */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "5px",
          background: "var(--bg-elevated)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            id="tab-interactive-terminal"
            onClick={() => setMode("terminal")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 16px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
              transition: "all 150ms",
              background: mode === "terminal" ? "#ffffff" : "transparent",
              color: mode === "terminal" ? "#000000" : "var(--text-secondary)",
              boxShadow: mode === "terminal" ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
            }}
          >
            <Terminal style={{ width: 14, height: 14 }} />
            Live Interactive Terminal
          </button>
          <button
            type="button"
            id="tab-script-deployment"
            onClick={() => setMode("script")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 16px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
              transition: "all 150ms",
              background: mode === "script" ? "#ffffff" : "transparent",
              color: mode === "script" ? "#000000" : "var(--text-secondary)",
              boxShadow: mode === "script" ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
            }}
          >
            <FileCode style={{ width: 14, height: 14 }} />
            PowerShell Script Payload
          </button>
        </div>

        <div style={{ paddingRight: 12, fontSize: 11, color: "var(--text-tertiary)" }}>
          {mode === "terminal" ? "Live interactive execution & audit" : "Queued batch job submission"}
        </div>
      </div>

      {mode === "terminal" ? (
        <WorkingTerminal
          devices={devices}
          initialDeviceId={watchedDeviceId || devices[0]?.id}
        />
      ) : (
        <form onSubmit={handleSubmit(onValidSubmit as any)} noValidate style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="card"
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "rgba(248,113,113,0.08)",
                borderColor: "rgba(248,113,113,0.25)",
                color: "var(--status-error)",
                fontSize: 13,
              }}
            >
              <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
              <span>{error}</span>
            </motion.div>
          )}

        {/* Target Device */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <Monitor style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Target Node
            </h2>
          </div>

          {devices.length === 0 ? (
            <div
              style={{
                padding: "16px",
                borderRadius: "var(--radius-md)",
                background: "rgba(251,191,36,0.08)",
                border: "1px solid rgba(251,191,36,0.20)",
                color: "var(--status-warning)",
                fontSize: 12.5,
              }}
            >
              No enrolled devices available. Enroll a target Windows machine first.
            </div>
          ) : (
            <>
              <select
                className="input"
                id="device-select"
                {...register("device_id")}
                aria-label="Select target device"
                style={{ background: "var(--bg-overlay)" }}
              >
                <option value="">— Select a target device —</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.isOnline ? "●" : "○"} {d.display_name} {d.hostname ? `(${d.hostname})` : ""} {d.isOnline ? "— Online" : "— Offline"}
                  </option>
                ))}
              </select>
              {errors.device_id && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 5 }}>
                  {errors.device_id.message}
                </p>
              )}

              {selectedDevice && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    marginTop: 12,
                    padding: "12px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)" }}>
                    <Info style={{ width: 13, height: 13, color: "var(--text-tertiary)", flexShrink: 0 }} />
                    <span>
                      Runs headless under authorized worker credentials on{" "}
                      <strong style={{ color: "var(--text-primary)" }}>{selectedDevice.display_name}</strong>.
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: selectedDevice.isOnline ? "var(--status-online)" : "var(--status-warning)",
                      }}
                    />
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                      {selectedDevice.isOnline ? "Device online — executes promptly" : "Device offline — queued until online"}
                    </span>
                  </div>
                </motion.div>
              )}
            </>
          )}
        </div>

        {/* Script Editor */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FileCode style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
              <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                PowerShell Payload
              </h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontFamily: "monospace", color: bytesOverLimit ? "var(--status-error)" : "var(--text-tertiary)" }}>
                {(scriptBytes / 1024).toFixed(1)} / {(maxScriptBytes / 1024).toFixed(0)} KB
              </span>
              <div style={{ width: 64, height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${bytesPct}%`,
                    background: bytesOverLimit ? "var(--status-error)" : "var(--text-primary)",
                    transition: "width 200ms",
                  }}
                />
              </div>
            </div>
          </div>

          <Controller
            name="script_content"
            control={control}
            render={({ field }) => (
              <div
                style={{
                  borderRadius: "var(--radius-md)",
                  overflow: "hidden",
                  border: "1px solid var(--border-default)",
                  height: 320,
                  background: "#0d0d0d",
                }}
              >
                <MonacoEditor
                  height="320px"
                  language="powershell"
                  theme="vs-dark"
                  value={field.value}
                  onChange={(val) => {
                    field.onChange(val ?? "");
                    handleScriptChange(val);
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    renderWhitespace: "none",
                    folding: true,
                    automaticLayout: true,
                    tabSize: 2,
                  }}
                />
              </div>
            )}
          />
          {errors.script_content && (
            <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 5 }}>
              {errors.script_content.message}
            </p>
          )}
        </div>

        {/* Options */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <Clock style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Execution Parameters
            </h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            <div>
              <label className="label">Timeout (seconds)</label>
              <input type="number" className="input" min={1} max={86400} {...register("timeout_seconds")} />
              {errors.timeout_seconds && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>{errors.timeout_seconds.message}</p>
              )}
            </div>
            <div>
              <label className="label">Expires In (seconds)</label>
              <input type="number" className="input" min={60} max={604800} {...register("expires_in_seconds")} />
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <input className="input" placeholder="e.g. Audit security logs" {...register("description")} />
            </div>
            <div>
              <label className="label">Change Ticket (optional)</label>
              <input className="input" placeholder="e.g. SEC-1049" {...register("change_ticket")} />
            </div>
          </div>
        </div>

        {/* Authorization checkbox */}
        <div
          className="card"
          style={{
            padding: "16px 20px",
            background: "rgba(255,255,255,0.02)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <input
            type="checkbox"
            id="confirm-checkbox"
            {...register("confirm")}
            style={{
              marginTop: 3,
              width: 16,
              height: 16,
              accentColor: "#ffffff",
              cursor: "pointer",
            }}
          />
          <div>
            <label htmlFor="confirm-checkbox" style={{ fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer", lineHeight: 1.4 }}>
              I confirm this remote PowerShell script is authorized to run on the prospective node.
              Execution details and full output will be permanently captured in the immutable audit log.
            </label>
            {errors.confirm && (
              <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                {errors.confirm.message}
              </p>
            )}
          </div>
        </div>

        {/* Submit Button */}
        <div>
          <button
            type="submit"
            id="submit-job-btn"
            disabled={submitting || bytesOverLimit || devices.length === 0}
            className="btn btn-primary btn-lg"
            style={{ width: "100%", maxWidth: 220 }}
          >
            {submitting ? (
              <>
                <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" />
                Dispatching…
              </>
            ) : (
              <>
                <Play style={{ width: 14, height: 14 }} />
                Execute Payload
              </>
            )}
          </button>
        </div>
      </form>
      )}

      {/* Confirmation Modal */}
      <AnimatePresence>
        {showConfirmModal && pendingValues && selectedDevice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 50,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              background: "rgba(0,0,0,0.75)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="card"
              style={{
                width: "100%",
                maxWidth: 440,
                padding: "24px 28px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                boxShadow: "var(--shadow-lg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ShieldCheck style={{ width: 18, height: 18, color: "var(--text-primary)" }} />
                  <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
                    Confirm Dispatch
                  </h2>
                </div>
                <button
                  onClick={() => setShowConfirmModal(false)}
                  className="btn-icon"
                  style={{ width: 28, height: 28 }}
                >
                  <X style={{ width: 14, height: 14 }} />
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)", paddingBottom: 8 }}>
                  <span style={{ color: "var(--text-tertiary)" }}>Target Device</span>
                  <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{selectedDevice.display_name}</span>
                </div>
                {selectedDevice.hostname && (
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)", paddingBottom: 8 }}>
                    <span style={{ color: "var(--text-tertiary)" }}>Hostname</span>
                    <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>{selectedDevice.hostname}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)", paddingBottom: 8 }}>
                  <span style={{ color: "var(--text-tertiary)" }}>Timeout Limit</span>
                  <span style={{ color: "var(--text-secondary)" }}>{pendingValues.timeout_seconds}s</span>
                </div>
                {pendingValues.change_ticket && (
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)", paddingBottom: 8 }}>
                    <span style={{ color: "var(--text-tertiary)" }}>Change Ticket</span>
                    <span style={{ color: "var(--text-secondary)" }}>{pendingValues.change_ticket}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-tertiary)" }}>Execution Identity</span>
                  <span style={{ color: "var(--text-primary)", fontSize: 11, fontFamily: "monospace" }}>ScriptRunnerService</span>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowConfirmModal(false)}
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executeSubmit}
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  id="confirm-submit-btn"
                >
                  <Play style={{ width: 13, height: 13 }} /> Confirm & Run
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
