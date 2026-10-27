import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext, formatRelative, severityBadge, stateBadge } from "@/lib/rmm/page-auth";
import { createMonitorAction, deleteMonitorAction, updateMonitorAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";
import { Activity, Plus, Trash2 } from "lucide-react";

export const metadata = { title: "Monitoring" };
export const dynamic = "force-dynamic";

export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const admin = await adminPageContext("/dashboard/monitoring");
  const supabase = createServiceClient();

  const [{ data: monitors }, { data: devices }, { data: groups }] = await Promise.all([
    supabase
      .from("monitors")
      .select("*")
      .eq("organization_id", admin.organizationId)
      .order("created_at", { ascending: false }),
    supabase
      .from("devices")
      .select("id, hostname, display_name, enrollment_status")
      .eq("organization_id", admin.organizationId)
      .order("display_name"),
    supabase
      .from("device_groups")
      .select("id, name, group_type")
      .eq("organization_id", admin.organizationId)
      .order("name"),
  ]);

  const monitorIds = (monitors ?? []).map((m: any) => m.id);
  const { data: states } = monitorIds.length
    ? await supabase.from("monitor_state").select("*").in("monitor_id", monitorIds)
    : { data: [] as any[] };

  const stateByMonitor = new Map<string, any[]>();
  for (const state of states ?? []) {
    const list = stateByMonitor.get(state.monitor_id) ?? [];
    list.push(state);
    stateByMonitor.set(state.monitor_id, list);
  }

  const deviceName = (id: string | null) => {
    if (!id) return "All devices";
    const device = (devices ?? []).find((d: any) => d.id === id);
    return device?.hostname ?? device?.display_name ?? id;
  };

  const groupName = (id: string | null) =>
    (groups ?? []).find((g: any) => g.id === id)?.name ?? "Unknown group";

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Monitoring</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            Configure endpoint checks. Results are evaluated on the agent; sustained breaches raise alerts.
          </p>
        </div>

        <Notice error={error} />

        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <Plus style={{ width: 15, height: 15 }} />
            <h2 style={{ fontSize: 13, fontWeight: 600 }}>Create monitor</h2>
          </div>

          <form action={createMonitorAction} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              <div>
                <label className="label" htmlFor="monitor-name">Name</label>
                <input id="monitor-name" name="name" className="input" required maxLength={160} placeholder="Sustained high CPU" />
              </div>
              <div>
                <label className="label" htmlFor="monitor-kind">Check type</label>
                <select id="monitor-kind" name="kind" className="input" defaultValue="cpu">
                  {[
                    ["cpu", "CPU utilisation"], ["memory", "Memory pressure"], ["disk", "Disk free space"],
                    ["process", "Process presence / resource"], ["service", "Windows service"],
                    ["event_log", "Event log condition"], ["file", "File condition"],
                    ["directory", "Directory condition"], ["registry", "Registry value"],
                    ["powershell", "PowerShell check (admin opt-in)"], ["ping", "Ping reachability"],
                    ["tcp", "TCP port"], ["hardware", "Hardware property"], ["os", "OS property"],
                    ["custom_metric", "Metric threshold"],
                  ].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="monitor-scope">Scope</label>
                <select id="monitor-scope" name="scope" className="input" defaultValue="org">
                  <option value="org">Whole organization</option>
                  <option value="device">One device</option>
                  <option value="group">Device group</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="monitor-device">Device (for device scope)</label>
                <select id="monitor-device" name="device_id" className="input" defaultValue="">
                  <option value="">—</option>
                  {(devices ?? []).map((d: any) => (
                    <option key={d.id} value={d.id}>{d.hostname ?? d.display_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="monitor-group">Group (for group scope)</label>
                <select id="monitor-group" name="group_id" className="input" defaultValue="">
                  <option value="">—</option>
                  {(groups ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="monitor-severity">Severity</label>
                <select id="monitor-severity" name="severity" className="input" defaultValue="warning">
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="monitor-interval">Interval (seconds)</label>
                <input id="monitor-interval" name="interval_seconds" type="number" min={15} max={86400} defaultValue={60} className="input" />
              </div>
              <div>
                <label className="label" htmlFor="monitor-timeout">Timeout (seconds)</label>
                <input id="monitor-timeout" name="timeout_seconds" type="number" min={1} max={600} defaultValue={30} className="input" />
              </div>
              <div>
                <label className="label" htmlFor="monitor-breach">Consecutive breaches</label>
                <input id="monitor-breach" name="breach_samples" type="number" min={1} max={60} defaultValue={1} className="input" />
              </div>
              <div>
                <label className="label" htmlFor="monitor-recovery">Samples to recover</label>
                <input id="monitor-recovery" name="recovery_samples" type="number" min={1} max={60} defaultValue={1} className="input" />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="monitor-config">Check configuration (JSON)</label>
              <textarea
                id="monitor-config"
                name="config"
                className="input"
                rows={4}
                defaultValue={'{"threshold":85,"comparison":"gte"}'}
                spellCheck={false}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              />
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                Examples: disk <code>{'{"volume":"C:","threshold":90}'}</code> · service{" "}
                <code>{'{"service_name":"Spooler","expected_status":"running"}'}</code> · file{" "}
                <code>{'{"path":"C:\\\\ProgramData\\\\app\\\\ready.flag","condition":"exists"}'}</code>
              </p>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input type="checkbox" name="auto_recovery" />
                Allow bounded service recovery (organization policy must also allow it)
              </label>
              <input name="recovery_action" className="input" style={{ maxWidth: 260 }} placeholder='{"action":"restart"}' aria-label="Recovery action JSON" />
              <button className="btn btn-primary btn-sm" type="submit">Create monitor</button>
            </div>
          </form>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
            <Activity style={{ width: 15, height: 15 }} />
            <h2 style={{ fontSize: 13, fontWeight: 600 }}>Monitors ({monitors?.length ?? 0})</h2>
          </div>

          {(monitors ?? []).length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              No monitors configured. Devices will report only default telemetry.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th><th>Type</th><th>Scope</th><th>State</th><th>Last result</th>
                    <th>Interval</th><th>Severity</th><th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(monitors ?? []).map((monitor: any) => {
                    const current = stateByMonitor.get(monitor.id) ?? [];
                    const failing = current.filter((s) => ["warning", "critical", "error"].includes(s.last_status));
                    return (
                      <tr key={monitor.id}>
                        <td style={{ fontWeight: 600 }}>{monitor.name}</td>
                        <td><span className="badge badge-default">{monitor.kind}</span></td>
                        <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          {monitor.device_id ? deviceName(monitor.device_id) : monitor.group_id ? groupName(monitor.group_id) : "Organization"}
                        </td>
                        <td>
                          <span className={stateBadge(monitor.enabled ? (failing.length ? "warning" : "ok") : "unknown")}>
                            {monitor.enabled ? (failing.length ? `${failing.length} failing` : "enabled") : "disabled"}
                          </span>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {failing.length === 0
                            ? current[0]?.last_status ?? "No results"
                            : failing[0]?.last_message ?? "Breaching"}
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                            {formatRelative(current[0]?.last_run_at)}
                          </div>
                        </td>
                        <td style={{ fontSize: 12 }}>{monitor.interval_seconds}s</td>
                        <td><span className={severityBadge(monitor.severity)}>{monitor.severity}</span></td>
                        <td>
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                            <form action={updateMonitorAction} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input type="hidden" name="monitor_id" value={monitor.id} />
                              <input type="hidden" name="severity" value={monitor.severity} />
                              <input type="hidden" name="interval_seconds" value={monitor.interval_seconds} />
                              <input type="hidden" name="breach_samples" value={monitor.breach_samples} />
                              <input type="hidden" name="enabled" value={monitor.enabled ? "" : "on"} />
                              <button className="btn btn-secondary btn-sm" type="submit">
                                {monitor.enabled ? "Disable" : "Enable"}
                              </button>
                            </form>
                            <form action={deleteMonitorAction}>
                              <input type="hidden" name="monitor_id" value={monitor.id} />
                              <button className="btn btn-danger btn-sm" type="submit" aria-label={`Delete ${monitor.name}`}>
                                <Trash2 style={{ width: 12, height: 12 }} />
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
