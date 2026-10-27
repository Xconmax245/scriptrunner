"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Save, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface SettingsData {
  max_script_bytes: number;
  default_timeout_secs: number;
  default_expiry_secs: number;
  max_stdout_bytes: number;
  operators_can_submit: boolean;
  audit_retention_days: number;
  output_retention_days: number;
}

interface Props {
  orgId: string;
  isElevated: boolean;
  initialSettings: SettingsData;
}

export function SettingsForm({ orgId, isElevated, initialSettings }: Props) {
  const router = useRouter();
  const [formData, setFormData] = useState<SettingsData>(initialSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isElevated) return;

    setIsSaving(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const supabase = createClient();

      const { error } = await (supabase as any)
        .from("organization_settings")
        .upsert({
          organization_id: orgId,
          max_script_bytes: Number(formData.max_script_bytes),
          default_timeout_secs: Number(formData.default_timeout_secs),
          default_expiry_secs: Number(formData.default_expiry_secs),
          max_stdout_bytes: Number(formData.max_stdout_bytes),
          operators_can_submit: Boolean(formData.operators_can_submit),
          audit_retention_days: Number(formData.audit_retention_days),
          output_retention_days: Number(formData.output_retention_days),
          updated_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(error.message);
      }

      setSuccessMessage("Governance policies updated successfully.");
      router.refresh();
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update organization settings"
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {successMessage && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid rgba(52,211,153,0.25)",
            background: "rgba(52,211,153,0.08)",
            color: "var(--status-online)",
            fontSize: 12.5,
          }}
        >
          <CheckCircle2 style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span>{successMessage}</span>
        </div>
      )}

      {errorMessage && (
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
            fontSize: 12.5,
          }}
        >
          <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span>{errorMessage}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
        <div>
          <label className="label">Default Execution Timeout (s)</label>
          <input
            type="number"
            min="10"
            max="86400"
            disabled={!isElevated || isSaving}
            value={formData.default_timeout_secs}
            onChange={(e) =>
              setFormData({ ...formData, default_timeout_secs: parseInt(e.target.value) || 300 })
            }
            className="input"
          />
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Hard process cutoff time before termination.
          </p>
        </div>

        <div>
          <label className="label">Default Job Expiration (s)</label>
          <input
            type="number"
            min="60"
            max="604800"
            disabled={!isElevated || isSaving}
            value={formData.default_expiry_secs}
            onChange={(e) =>
              setFormData({ ...formData, default_expiry_secs: parseInt(e.target.value) || 86400 })
            }
            className="input"
          />
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Unclaimed jobs expire after this period if the node is offline.
          </p>
        </div>

        <div>
          <label className="label">Max Script Payload (Bytes)</label>
          <input
            type="number"
            min="1024"
            max="131072"
            disabled={!isElevated || isSaving}
            value={formData.max_script_bytes}
            onChange={(e) =>
              setFormData({ ...formData, max_script_bytes: parseInt(e.target.value) || 131072 })
            }
            className="input"
          />
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Maximum allowable size of submitted script files.
          </p>
        </div>

        <div>
          <label className="label">Max Captured Output (Bytes)</label>
          <input
            type="number"
            min="1024"
            max="65536"
            disabled={!isElevated || isSaving}
            value={formData.max_stdout_bytes}
            onChange={(e) =>
              setFormData({ ...formData, max_stdout_bytes: parseInt(e.target.value) || 65536 })
            }
            className="input"
          />
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Output buffer cap to avoid database pollution.
          </p>
        </div>
      </div>

      <div
        style={{
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-subtle)",
          background: "var(--bg-overlay)",
          padding: 16,
        }}
      >
        <label style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            disabled={!isElevated || isSaving}
            checked={formData.operators_can_submit}
            onChange={(e) =>
              setFormData({ ...formData, operators_can_submit: e.target.checked })
            }
            style={{ marginTop: 2, accentColor: "#ffffff", cursor: "pointer" }}
          />
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Allow Operators to Submit Jobs
            </span>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              When enabled, team members with the operator role can dispatch approved scripts.
            </p>
          </div>
        </label>
      </div>

      {isElevated ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            disabled={isSaving}
            className="btn btn-primary"
          >
            {isSaving ? (
              <>
                <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save style={{ width: 13, height: 13 }} />
                Save Policies
              </>
            )}
          </button>
        </div>
      ) : (
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "right" }}>
          Read-only mode. Only owners and administrators can modify settings.
        </p>
      )}
    </form>
  );
}
