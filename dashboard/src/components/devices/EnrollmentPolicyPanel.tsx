"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

interface Props {
  organizationId: string;
}

export function EnrollmentPolicyPanel({ organizationId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [autoAuthorize, setAutoAuthorize] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [name, setName] = useState("Fleet enrollment key");
  const [expiresHours, setExpiresHours] = useState<number | "">("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    enrollment_key: string;
    install_command: string;
    key_prefix: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/enrollment-keys?organization_id=${encodeURIComponent(organizationId)}`
      );
      const payload = await response.json();
      if (!response.ok) {
        setUnauthorized(response.status === 401 || response.status === 403);
        setError(payload.error ?? "Failed to load enrollment policy");
        return;
      }
      setUnauthorized(false);
      setKeys(payload.keys ?? []);
      setAutoAuthorize(Boolean(payload.auto_authorize_devices));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const createKey = async () => {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/enrollment-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          name: name.trim() || "Fleet enrollment key",
          expires_in_hours: expiresHours === "" ? undefined : Number(expiresHours),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setUnauthorized(response.status === 401 || response.status === 403);
        setError(payload.error ?? "Failed to create key");
        return;
      }
      setCreated({
        enrollment_key: payload.enrollment_key,
        install_command: payload.install_command,
        key_prefix: payload.key.key_prefix,
      });
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  };

  const savePolicy = async (nextAutoAuthorize: boolean) => {
    setSavingPolicy(true);
    setError(null);
    setAutoAuthorize(nextAutoAuthorize);
    try {
      const response = await fetch("/api/enrollment-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          auto_authorize_devices: nextAutoAuthorize,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setAutoAuthorize(!nextAutoAuthorize);
        setError(payload.error ?? "Failed to save policy");
      }
    } catch (err) {
      setAutoAuthorize(!nextAutoAuthorize);
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSavingPolicy(false);
    }
  };

  const revokeKey = async (id: string) => {
    if (!window.confirm("Revoke this enrollment key? Existing devices keep working; new installs cannot enroll with it.")) {
      return;
    }
    const response = await fetch(`/api/enrollment-keys/${id}/revoke`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Failed to revoke key");
      return;
    }
    await load();
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const close = () => {
    setOpen(false);
    setCreated(null);
    setError(null);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn btn-primary btn-sm" id="enrollment-policy-btn">
        <KeyRound style={{ width: 13, height: 13 }} />
        Provisioning Setup
      </button>

      <AnimatePresence>
        {open && (
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
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="card"
              style={{
                width: "100%",
                maxWidth: 620,
                maxHeight: "90vh",
                overflowY: "auto",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                boxShadow: "var(--shadow-lg)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "18px 24px",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
                    Automated Node Enrollment
                  </h2>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    Organization-wide cryptographic keys &middot; zero per-device invitation tokens
                  </p>
                </div>
                <button onClick={close} className="btn-icon" aria-label="Close" style={{ width: 30, height: 30 }}>
                  <X style={{ width: 14, height: 14 }} />
                </button>
              </div>

              <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
                {unauthorized ? (
                  <div
                    style={{
                      borderRadius: "var(--radius-md)",
                      border: "1px solid rgba(251,191,36,0.25)",
                      background: "rgba(251,191,36,0.08)",
                      padding: 16,
                      fontSize: 12.5,
                      color: "var(--status-warning)",
                    }}
                  >
                    <p style={{ fontWeight: 600 }}>Administrator sign-in required</p>
                    <p style={{ fontSize: 11, marginTop: 4, color: "rgba(255,255,255,0.7)" }}>
                      Key generation is restricted to organization owners and administrators.
                    </p>
                    <a href="/auth/sign-in?next=/dashboard/devices" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>
                      Sign in
                    </a>
                  </div>
                ) : created ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div
                      style={{
                        borderRadius: "var(--radius-md)",
                        border: "1px solid rgba(52,211,153,0.25)",
                        background: "rgba(52,211,153,0.08)",
                        padding: 14,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                      }}
                    >
                      <ShieldCheck style={{ width: 16, height: 16, color: "var(--status-online)", flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--status-online)" }}>
                          Enrollment key generated
                        </p>
                        <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                          This key is displayed only once. Supply it to prospective endpoints via installer or MDM script.
                        </p>
                      </div>
                    </div>

                    <div>
                      <p className="label">Cryptographic Organization Key</p>
                      <div style={{ position: "relative" }}>
                        <pre className="code-block" style={{ fontSize: 11, paddingRight: 40 }}>
                          {created.enrollment_key}
                        </pre>
                        <button
                          onClick={() => void copyText(created.enrollment_key)}
                          className="btn-icon"
                          style={{ position: "absolute", right: 6, top: 6, width: 28, height: 28 }}
                        >
                          {copied ? <Check style={{ width: 13, height: 13, color: "var(--status-online)" }} /> : <Copy style={{ width: 13, height: 13 }} />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="label">Elevated PowerShell One-Liner</p>
                      <div style={{ position: "relative" }}>
                        <pre className="code-block" style={{ fontSize: 11, paddingRight: 40, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                          {created.install_command}
                        </pre>
                        <button
                          onClick={() => void copyText(created.install_command)}
                          className="btn-icon"
                          style={{ position: "absolute", right: 6, top: 6, width: 28, height: 28 }}
                        >
                          <Copy style={{ width: 13, height: 13 }} />
                        </button>
                      </div>
                    </div>

                    <button onClick={() => setCreated(null)} className="btn btn-secondary" style={{ width: "100%", marginTop: 8 }}>
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <>
                    {error && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 14px",
                          borderRadius: "var(--radius-md)",
                          border: "1px solid rgba(248,113,113,0.25)",
                          background: "rgba(248,113,113,0.08)",
                          color: "var(--status-error)",
                          fontSize: 12,
                        }}
                      >
                        <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
                        <span>{error}</span>
                      </div>
                    )}

                    {/* Auto authorize checkbox */}
                    <label
                      className="card"
                      style={{
                        padding: "14px 16px",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        cursor: "pointer",
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={autoAuthorize}
                        disabled={savingPolicy}
                        onChange={(e) => void savePolicy(e.target.checked)}
                        style={{ marginTop: 2, accentColor: "#ffffff", cursor: "pointer" }}
                      />
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                          Automatically authorize new devices
                        </span>
                        <span style={{ display: "block", fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                          When disabled, enrolled prospective PCs require administrative approval before receiving jobs.
                        </span>
                      </div>
                    </label>

                    {/* Creation inputs */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 120px auto", gap: 10, alignItems: "flex-end" }}>
                      <div>
                        <label className="label" htmlFor="key-name">Key Label</label>
                        <input
                          id="key-name"
                          className="input"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          maxLength={120}
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor="key-expiry">TTL (Hours)</label>
                        <input
                          id="key-expiry"
                          type="number"
                          min={1}
                          max={8760}
                          className="input"
                          placeholder="Never"
                          value={expiresHours}
                          onChange={(e) => setExpiresHours(e.target.value === "" ? "" : Number(e.target.value))}
                        />
                      </div>
                      <button
                        onClick={() => void createKey()}
                        disabled={creating}
                        className="btn btn-primary"
                        id="create-enrollment-key-btn"
                        style={{ height: 38 }}
                      >
                        {creating ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <KeyRound style={{ width: 13, height: 13 }} />}
                        Create
                      </button>
                    </div>

                    {/* Existing keys list */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                          Active Enrollment Credentials
                        </p>
                        <button onClick={() => void load()} className="btn-icon" aria-label="Refresh" style={{ width: 26, height: 26 }}>
                          <RefreshCw style={{ width: 12, height: 12 }} className={loading ? "animate-spin" : undefined} />
                        </button>
                      </div>

                      {loading && keys.length === 0 ? (
                        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Loading credentials…</p>
                      ) : keys.length === 0 ? (
                        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                          No enrollment key generated yet.
                        </p>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {keys.map((key) => {
                            const revoked = Boolean(key.revoked_at);
                            const expired = key.expires_at ? new Date(key.expires_at).getTime() <= Date.now() : false;
                            return (
                              <div
                                key={key.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  padding: "10px 14px",
                                  borderRadius: "var(--radius-sm)",
                                  background: "var(--bg-overlay)",
                                  border: "1px solid var(--border-subtle)",
                                  fontSize: 12,
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <p style={{ fontWeight: 500, color: "var(--text-primary)" }}>{key.name}</p>
                                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 2 }}>
                                    {key.key_prefix}… &middot; used {key.use_count}× &middot;{" "}
                                    {key.last_used_at ? `last ${new Date(key.last_used_at).toLocaleDateString()}` : "never used"}
                                  </p>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span
                                    className="badge"
                                    style={{
                                      color: revoked ? "var(--status-error)" : expired ? "var(--status-warning)" : "var(--status-online)",
                                      background: revoked ? "rgba(248,113,113,0.1)" : expired ? "rgba(251,191,36,0.1)" : "rgba(52,211,153,0.1)",
                                      borderColor: "transparent",
                                    }}
                                  >
                                    {revoked ? "Revoked" : expired ? "Expired" : "Active"}
                                  </span>
                                  {!revoked && (
                                    <button
                                      onClick={() => void revokeKey(key.id)}
                                      style={{ background: "none", border: "none", color: "var(--status-error)", fontSize: 11, cursor: "pointer" }}
                                    >
                                      Revoke
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
