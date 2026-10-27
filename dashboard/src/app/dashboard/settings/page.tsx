import { createClient } from "@/lib/supabase/server";
import { formatDistanceToNow, format } from "date-fns";
import {
  Shield,
  Users,
  Sliders,
  Clock,
  HardDrive,
  FileText,
  KeyRound,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { SettingsForm } from "@/components/settings/SettingsForm";
import { updateRmmSettingsAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";

export const metadata = {
  title: "Organization Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();

  let user: { id: string } | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {}

  let member: {
    role: string;
    organization: {
      id: string;
      name: string;
      slug: string;
      created_at: string;
    };
  } | null = null;

  if (user) {
    try {
      const { data: memberData } = await supabase
        .from("organization_members")
        .select("role, organization:organizations(id, name, slug, created_at)")
        .eq("user_id", user.id)
        .single();
      member = memberData as any;
    } catch {}
  }

  const org = member?.organization || {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Corporate Systems",
    slug: "corporate-systems",
    created_at: new Date().toISOString(),
  };

  const { data: settingsData } = await supabase
    .from("organization_settings")
    .select("*")
    .eq("organization_id", org.id)
    .single();

  const settings = settingsData as unknown as {
    max_script_bytes: number;
    default_timeout_secs: number;
    default_expiry_secs: number;
    max_stdout_bytes: number;
    operators_can_submit: boolean;
    audit_retention_days: number;
    output_retention_days: number;
  } | null;

  const { data: membersData } = await supabase
    .from("organization_members")
    .select("id, role, created_at, user_id")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });

  const members = (membersData ?? []) as unknown as Array<{
    id: string;
    role: string;
    created_at: string;
    user_id: string;
  }>;

  const { data: auditData } = await supabase
    .from("audit_events")
    .select("id, action, actor_type, actor_id, target_type, target_id, timestamp, metadata")
    .eq("organization_id", org.id)
    .order("timestamp", { ascending: false })
    .limit(10);

  const auditEvents = (auditData ?? []) as unknown as Array<{
    id: string;
    action: string;
    actor_type: string;
    actor_id: string | null;
    target_type: string | null;
    target_id: string | null;
    timestamp: string;
    metadata: unknown;
  }>;

  const isElevated = !member || member?.role === "owner" || member?.role === "administrator";
  const currentRole = member?.role || "owner";

  return (
    <PageTransition>
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Organization Settings
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            Manage governance policies, script execution limits, team access, and audit streams.
          </p>
        </div>

        {/* Organization Info Card */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: "var(--bg-overlay)",
                  border: "1px solid var(--border-default)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Shield style={{ width: 20, height: 20, color: "var(--text-primary)" }} />
              </div>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{org.name}</h2>
                <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 2 }}>
                  slug: {org.slug} &middot; Created {format(new Date(org.created_at), "PP")}
                </p>
              </div>
            </div>
            <div>
              <span
                className="badge"
                style={{
                  color: "var(--text-primary)",
                  background: "var(--bg-overlay)",
                  borderColor: "var(--border-strong)",
                  fontSize: 11,
                  padding: "4px 10px",
                }}
              >
                Role: {currentRole}
              </span>
            </div>
          </div>
        </div>

        {/* Execution Policy Form */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, borderBottom: "1px solid var(--border-subtle)", paddingBottom: 12 }}>
            <Sliders style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Execution Limits & Safeguards
            </h2>
          </div>

          <SettingsForm
            orgId={org.id}
            isElevated={isElevated}
            initialSettings={{
              max_script_bytes: settings?.max_script_bytes ?? 131072,
              default_timeout_secs: settings?.default_timeout_secs ?? 300,
              default_expiry_secs: settings?.default_expiry_secs ?? 86400,
              max_stdout_bytes: settings?.max_stdout_bytes ?? 65536,
              operators_can_submit: settings?.operators_can_submit ?? false,
              audit_retention_days: settings?.audit_retention_days ?? 90,
              output_retention_days: settings?.output_retention_days ?? 30,
            }}
          />
        </div>

        {/* RMM collection policy */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, borderBottom: "1px solid var(--border-subtle)", paddingBottom: 12 }}>
            <HardDrive style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Endpoint monitoring & software policy
            </h2>
          </div>

          <Notice error={error} />

          <form action={updateRmmSettingsAction} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
              <div>
                <label className="label" htmlFor="offline-after">Offline after (seconds)</label>
                <input id="offline-after" name="offline_after_seconds" type="number" min={60} max={86400} className="input" defaultValue={(settings as any)?.offline_after_seconds ?? 300} />
              </div>
              <div>
                <label className="label" htmlFor="metrics-interval">Metric interval (seconds)</label>
                <input id="metrics-interval" name="metrics_interval_seconds" type="number" min={10} max={3600} className="input" defaultValue={(settings as any)?.metrics_interval_seconds ?? 60} />
              </div>
              <div>
                <label className="label" htmlFor="inventory-interval">Inventory interval (seconds)</label>
                <input id="inventory-interval" name="inventory_interval_seconds" type="number" min={300} max={604800} className="input" defaultValue={(settings as any)?.inventory_interval_seconds ?? 21600} />
              </div>
              <div>
                <label className="label" htmlFor="software-interval">Software scan interval (seconds)</label>
                <input id="software-interval" name="software_scan_interval_seconds" type="number" min={300} max={604800} className="input" defaultValue={(settings as any)?.software_scan_interval_seconds ?? 21600} />
              </div>
              <div>
                <label className="label" htmlFor="event-interval">Event scan interval (seconds)</label>
                <input id="event-interval" name="event_scan_interval_seconds" type="number" min={60} max={86400} className="input" defaultValue={(settings as any)?.event_scan_interval_seconds ?? 300} />
              </div>
              <div>
                <label className="label" htmlFor="metrics-retention">Metric retention (days)</label>
                <input id="metrics-retention" name="metrics_retention_days" type="number" min={1} max={3650} className="input" defaultValue={(settings as any)?.metrics_retention_days ?? 30} />
              </div>
              <div>
                <label className="label" htmlFor="result-retention">Monitor result retention (days)</label>
                <input id="result-retention" name="monitor_results_retention_days" type="number" min={1} max={3650} className="input" defaultValue={(settings as any)?.monitor_results_retention_days ?? 30} />
              </div>
              <div>
                <label className="label" htmlFor="event-retention">Event retention (days)</label>
                <input id="event-retention" name="event_retention_days" type="number" min={1} max={3650} className="input" defaultValue={(settings as any)?.event_retention_days ?? 30} />
              </div>
              <div>
                <label className="label" htmlFor="deploy-concurrency">Deployment concurrency</label>
                <input id="deploy-concurrency" name="deployment_concurrency_limit" type="number" min={1} max={100} className="input" defaultValue={(settings as any)?.deployment_concurrency_limit ?? 5} />
              </div>
              <div>
                <label className="label" htmlFor="recovery-cooldown">Recovery cooldown (seconds)</label>
                <input id="recovery-cooldown" name="service_recovery_cooldown_seconds" type="number" min={60} max={86400} className="input" defaultValue={(settings as any)?.service_recovery_cooldown_seconds ?? 600} />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "var(--bg-overlay)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <input type="checkbox" name="allow_custom_powershell_monitors" defaultChecked={Boolean((settings as any)?.allow_custom_powershell_monitors)} />
                Allow administrators to run custom PowerShell monitors on endpoints
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <input type="checkbox" name="allow_security_event_collection" defaultChecked={Boolean((settings as any)?.allow_security_event_collection)} />
                Allow filtered Windows Security event collection (agent-local opt-in is also required)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <input type="checkbox" name="allow_service_recovery" defaultChecked={Boolean((settings as any)?.allow_service_recovery)} />
                Allow bounded automated service recovery (max 5 actions per service per 24h)
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary btn-sm" type="submit">Save monitoring policy</button>
            </div>
          </form>
        </div>

        {/* Organization Members List */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, borderBottom: "1px solid var(--border-subtle)", paddingBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Users style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
              <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                Team Members & Access
              </h2>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              {members?.length ?? 0} active members
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Role</th>
                  <th>Privileges</th>
                  <th style={{ textAlign: "right" }}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members?.map((m) => {
                  const isCurrentUser = Boolean(user && m.user_id === user.id);
                  return (
                    <tr key={m.id}>
                      <td>
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-secondary)" }}>
                          {m.user_id}
                        </span>
                        {isCurrentUser && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              fontWeight: 600,
                              color: "var(--text-primary)",
                              background: "var(--bg-hover)",
                              padding: "2px 6px",
                              borderRadius: 4,
                            }}
                          >
                            YOU
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className="badge"
                          style={{
                            color: "var(--text-primary)",
                            background: "var(--bg-overlay)",
                            borderColor: "var(--border-subtle)",
                          }}
                        >
                          {m.role}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                          {m.role === "owner" && "Full administrative control & policy"}
                          {m.role === "administrator" && "Device enrollment, scripts, management"}
                          {m.role === "operator" && "Script dispatch to assigned nodes"}
                          {m.role === "auditor" && "Read-only audit & logs"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                          {format(new Date(m.created_at), "yyyy-MM-dd")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Audit Activity */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, borderBottom: "1px solid var(--border-subtle)", paddingBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <KeyRound style={{ width: 15, height: 15, color: "var(--text-secondary)" }} />
              <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                Append-Only Audit Stream
              </h2>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Tamper-evident logs</span>
          </div>

          {!auditEvents || auditEvents.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "16px 0" }}>No audit events recorded.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {auditEvents.map((event) => (
                <div
                  key={event.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{event.action}</span>
                    <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>[{event.actor_type}]</span>
                    {event.target_type && (
                      <span style={{ color: "var(--text-tertiary)", fontSize: 11, fontFamily: "monospace" }}>
                        target: {event.target_type}
                      </span>
                    )}
                  </div>
                  <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
                    {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
