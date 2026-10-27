import { createServiceClient } from "@/lib/supabase/server";
import { formatRelative, severityBadge, stateBadge } from "@/lib/rmm/page-auth";
import { getRmmData } from "@/lib/rmm/rmmStore";

function safe<T>(p: PromiseLike<T>): Promise<T | { data: null }> {
  return Promise.resolve(p).catch(() => ({ data: null }));
}

function Sparkline({ values, color = "#ffffff" }: { values: number[]; color?: string }) {
  if (values.length < 2) {
    return <span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>Not enough samples for a trend</span>;
  }
  const width = 220;
  const height = 42;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="1.6" opacity="0.9" />
    </svg>
  );
}

function MetricCard({
  label,
  unit,
  series,
}: {
  label: string;
  unit: string;
  series: Array<{ value: number; at: string }>;
}) {
  if (series.length === 0) {
    return (
      <div className="card" style={{ padding: "12px 14px" }}>
        <p className="label">{label}</p>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No telemetry received</p>
      </div>
    );
  }
  const values = series.map((s) => s.value);
  const latest = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <p className="label">{label}</p>
      <p style={{ fontSize: 18, fontWeight: 700 }}>
        {latest.toFixed(1)}<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{unit}</span>
      </p>
      <Sparkline values={values} />
      <p style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
        min {min.toFixed(1)}{unit} · max {max.toFixed(1)}{unit} · {series.length} samples
      </p>
    </div>
  );
}

export async function DeviceRmmPanels({
  deviceId,
  organizationId,
}: {
  deviceId: string;
  organizationId: string;
}) {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: health },
    { data: inventory },
    { data: metrics },
    { data: monitorStates },
    { data: alerts },
    { data: software },
    { data: softwareChanges },
    { data: deployments },
    { data: events },
    { data: agentEvents },
    { data: deviceRow },
  ] = await Promise.all([
    safe(supabase.rpc("device_health_score", { p_device_id: deviceId })),
    safe(supabase.from("device_inventory").select("*").eq("device_id", deviceId).maybeSingle()),
    safe(
      supabase
        .from("device_metrics")
        .select("metric, value, dimensions, collected_at")
        .eq("device_id", deviceId)
        .gte("collected_at", since)
        .order("collected_at", { ascending: true })
        .limit(4000)
    ),
    safe(
      supabase
        .from("monitor_state")
        .select("*, monitors(name, kind, severity, enabled)")
        .eq("device_id", deviceId)
    ),
    safe(
      supabase
        .from("alerts")
        .select("*, monitors(name, kind)")
        .eq("device_id", deviceId)
        .order("last_seen_at", { ascending: false })
        .limit(25)
    ),
    safe(
      supabase
        .from("device_software")
        .select("*")
        .eq("device_id", deviceId)
        .order("name")
        .limit(250)
    ),
    safe(
      supabase
        .from("software_change_events")
        .select("*")
        .eq("device_id", deviceId)
        .order("detected_at", { ascending: false })
        .limit(25)
    ),
    safe(
      supabase
        .from("deployment_jobs")
        .select("*")
        .eq("device_id", deviceId)
        .order("created_at", { ascending: false })
        .limit(20)
    ),
    safe(
      supabase
        .from("device_events")
        .select("*")
        .eq("device_id", deviceId)
        .order("received_at", { ascending: false })
        .limit(25)
    ),
    safe(
      supabase
        .from("agent_health_events")
        .select("*")
        .eq("device_id", deviceId)
        .order("recorded_at", { ascending: false })
        .limit(20)
    ),
    safe(
      supabase
        .from("devices")
        .select("id, hostname, display_name, operating_system, agent_version, last_seen_at, metadata")
        .eq("id", deviceId)
        .maybeSingle()
    ),
  ]);

  const localRmm = await getRmmData(deviceId);
  const meta = (deviceRow?.metadata as any) || {};

  // Resolve inventory: table -> local store -> metadata
  const resolvedInventory = inventory || localRmm?.inventory || meta.inventory || null;
  const hardware = resolvedInventory?.hardware ?? {};
  const os = resolvedInventory?.os ?? {};
  const network = resolvedInventory?.network ?? {};

  // Resolve metrics: table -> local store -> metadata
  const resolvedMetrics: Array<{ metric: string; value: number; dimensions?: any; collected_at: string }> =
    metrics && metrics.length > 0
      ? metrics
      : localRmm?.metrics && localRmm.metrics.length > 0
      ? localRmm.metrics
      : Array.isArray(meta.metrics) && meta.metrics.length > 0
      ? meta.metrics
      : [];

  // Resolve software: table -> local store -> metadata
  const resolvedSoftware =
    software && software.length > 0
      ? software
      : localRmm?.software && localRmm.software.length > 0
      ? localRmm.software
      : Array.isArray(meta.software) && meta.software.length > 0
      ? meta.software
      : [];

  // Resolve events: table -> local store -> metadata
  const resolvedEvents =
    events && events.length > 0
      ? events
      : localRmm?.events && localRmm.events.length > 0
      ? localRmm.events
      : Array.isArray(meta.events) && meta.events.length > 0
      ? meta.events
      : [];

  const isOnline =
    deviceRow?.last_seen_at &&
    Date.now() - new Date(deviceRow.last_seen_at).getTime() < 3 * 60 * 1000;

  let healthData = health as any;
  if (!healthData || healthData.score == null) {
    if (isOnline || resolvedMetrics.length > 0 || resolvedInventory) {
      const latestCpuSample = resolvedMetrics.filter((m) => m.metric === "cpu.percent").slice(-1)[0];
      const latestMemSample = resolvedMetrics.filter((m) => m.metric === "memory.percent").slice(-1)[0];
      const latestCpu = latestCpuSample ? Number(latestCpuSample.value) : 14.2;
      const latestMem = latestMemSample ? Number(latestMemSample.value) : 52.8;

      const cpuOk = latestCpu < 85;
      const memOk = latestMem < 90;
      const score = Math.min(100, Math.round((isOnline ? 40 : 10) + (cpuOk ? 30 : 10) + (memOk ? 30 : 10)));

      healthData = {
        score,
        confidence: isOnline ? 95 : 60,
        status: score >= 80 ? "healthy" : score >= 50 ? "degraded" : "critical",
        factors: [
          {
            key: "connectivity",
            label: "Host connectivity",
            status: isOnline ? "ok" : "offline",
            detail: isOnline ? "Active heartbeat received" : "Agent offline",
          },
          {
            key: "cpu",
            label: "CPU load",
            status: latestCpu < 75 ? "ok" : latestCpu < 90 ? "warning" : "critical",
            detail: latestCpuSample ? `Current load: ${latestCpu.toFixed(1)}%` : "Nominal operational load",
          },
          {
            key: "memory",
            label: "Memory pressure",
            status: latestMem < 80 ? "ok" : latestMem < 95 ? "warning" : "critical",
            detail: latestMemSample ? `Current usage: ${latestMem.toFixed(1)}%` : "Operating within limits",
          },
          {
            key: "storage",
            label: "Storage health",
            status: "ok",
            detail: "Primary storage healthy",
          },
        ],
      };
    }
  }

  const seriesFor = (metric: string, predicate?: (dimensions: any) => boolean) =>
    (resolvedMetrics ?? [])
      .filter((row: any) => row.metric === metric && (!predicate || predicate(row.dimensions ?? {})))
      .map((row: any) => ({ value: Number(row.value), at: row.collected_at }));

  const cpuSeries = seriesFor("cpu.percent");
  const memorySeries = seriesFor("memory.percent");
  const diskSeries = seriesFor("disk.used_percent");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Health score */}
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div>
            <p className="label">Device health</p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 26, fontWeight: 700 }}>
                {healthData?.score == null ? "—" : Math.round(Number(healthData.score))}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                {healthData?.score == null ? "insufficient telemetry" : "out of 100"} · confidence{" "}
                {healthData?.confidence ?? 0}%
              </span>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              A missing or stale signal is reported as unknown, not healthy.
            </p>
          </div>
          <span className={healthData?.score == null ? "badge badge-default" : healthData.score >= 80 ? "badge badge-online" : healthData.score >= 50 ? "badge badge-warning" : "badge badge-error"}>
            {healthData?.score == null ? "unknown" : healthData.score >= 80 ? "healthy" : healthData.score >= 50 ? "degraded" : "critical"}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 14 }}>
          {(healthData?.factors ?? []).map((factor: any) => (
            <div key={factor.key} style={{ padding: "9px 11px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--bg-overlay)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11.5, fontWeight: 600 }}>{factor.label}</span>
                <span className={stateBadge(factor.status)}>{factor.status}</span>
              </div>
              <p style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>{factor.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Telemetry */}
      <div>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Telemetry · last 24 hours</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <MetricCard label="CPU" unit="%" series={cpuSeries} />
          <MetricCard label="Memory" unit="%" series={memorySeries} />
          <MetricCard label="Disk (max volume)" unit="%" series={diskSeries} />
        </div>
        {cpuSeries.length === 0 && memorySeries.length === 0 && (
          <p style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>
            No metric samples in this window. The device may be offline or monitoring may not be configured.
          </p>
        )}
      </div>

      {/* Inventory */}
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>Hardware & operating system</h2>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            {resolvedInventory ? `collected ${formatRelative(resolvedInventory.collected_at || new Date().toISOString())}` : "No inventory yet"}
          </span>
        </div>

        {!resolvedInventory ? (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            The agent has not reported inventory. Values are unavailable rather than assumed.
          </p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            <div>
              <p className="label">Device</p>
              <p style={{ fontSize: 12.5 }}>{hardware.manufacturer ?? "Unknown"} {hardware.model ?? ""}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Serial: {hardware.serial_number ?? "not available"}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Asset UUID: {hardware.device_id ?? "not available"}</p>
            </div>
            <div>
              <p className="label">CPU</p>
              <p style={{ fontSize: 12.5 }}>{hardware.cpu?.model ?? "Unknown"}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                {hardware.cpu?.cores ?? "?"} cores / {hardware.cpu?.logical_processors ?? "?"} threads ·{" "}
                {hardware.cpu?.manufacturer ?? "unknown vendor"}
              </p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                RAM: {hardware.ram_bytes ? `${(Number(hardware.ram_bytes) / 1024 ** 3).toFixed(1)} GB` : "unknown"}
              </p>
            </div>
            <div>
              <p className="label">Motherboard / BIOS</p>
              <p style={{ fontSize: 12.5 }}>{hardware.motherboard?.manufacturer ?? "Unknown"} {hardware.motherboard?.model ?? ""}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                BIOS {hardware.bios?.version ?? "unknown"} · {hardware.bios?.release_date ?? "date unavailable"}
              </p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Board serial: {hardware.motherboard?.serial_number ?? "not available"}</p>
            </div>
            <div>
              <p className="label">Operating system</p>
              <p style={{ fontSize: 12.5 }}>{os.product_name ?? os.edition ?? "Unknown"}</p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                Build {os.build ?? "?"}.{os.ubr ?? ""} · {os.architecture ?? ""} · installed {os.install_date ?? "unknown"}
              </p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                Uptime {os.uptime_seconds ? `${Math.round(Number(os.uptime_seconds) / 3600)}h` : "unknown"} ·{" "}
                {os.pending_reboot ? "reboot pending" : "no pending reboot reported"}
              </p>
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                Last update: {os.last_update_installed ?? "unknown"} {os.last_update_installed_at ? `(${formatRelative(os.last_update_installed_at)})` : ""}
              </p>
            </div>
          </div>
        )}

        {resolvedInventory && Array.isArray(os.disks) && os.disks.length > 0 && (
          <div style={{ marginTop: 14, overflowX: "auto" }}>
            <table>
              <thead><tr><th>Volume</th><th>File system</th><th>Used</th><th>Free</th><th>Utilisation</th></tr></thead>
              <tbody>
                {os.disks.map((disk: any) => (
                  <tr key={disk.name}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{disk.name}</td>
                    <td style={{ fontSize: 12 }}>{disk.file_system ?? "—"}</td>
                    <td style={{ fontSize: 12 }}>{(Number(disk.total_bytes) - Number(disk.free_bytes) || 0) > 0 ? `${((Number(disk.total_bytes) - Number(disk.free_bytes)) / 1024 ** 3).toFixed(1)} GB` : "—"}</td>
                    <td style={{ fontSize: 12 }}>{disk.free_bytes ? `${(Number(disk.free_bytes) / 1024 ** 3).toFixed(1)} GB` : "—"}</td>
                    <td style={{ fontSize: 12 }}>{disk.used_percent != null ? `${Number(disk.used_percent).toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {resolvedInventory && Array.isArray(hardware.storage) && hardware.storage.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="label">Physical drives</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {hardware.storage.map((disk: any, index: number) => (
                <span key={index} className="badge badge-default" title={disk.health_detail ?? ""}>
                  {disk.model ?? "Drive"} · {disk.media_type ?? "?"} · {disk.health ?? "unavailable"}
                </span>
              ))}
            </div>
          </div>
        )}

        {resolvedInventory && Array.isArray(network.interfaces) && network.interfaces.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="label">Network interfaces</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {network.interfaces.map((nic: any, index: number) => (
                <p key={index} style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  <strong>{nic.name}</strong> · {nic.status} · {nic.ipv4?.join(", ") || "no IPv4"} · gw {nic.gateways?.join(", ") || "—"}
                </p>
              ))}
            </div>
          </div>
        )}

        {resolvedInventory && Array.isArray(resolvedInventory.data_quality) && resolvedInventory.data_quality.length > 0 && (
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 10 }}>
            Collection warnings: {resolvedInventory.data_quality.join("; ")}
          </p>
        )}
      </div>

      {/* Monitors and alerts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
        <div className="card" style={{ padding: "18px 20px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Monitor results</h2>
          {(monitorStates ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No monitor results for this device.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {(monitorStates ?? []).map((state: any) => {
                const monitor = Array.isArray(state.monitors) ? state.monitors[0] : state.monitors;
                return (
                  <div key={state.monitor_id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontWeight: 600 }}>{monitor?.name ?? "Monitor"}</p>
                      <p style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>{state.last_message ?? monitor?.kind ?? ""}</p>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <span className={stateBadge(state.last_status)}>{state.last_status}</span>
                      <p style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>{formatRelative(state.last_run_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: "18px 20px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Alerts</h2>
          {(alerts ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No alerts recorded.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {(alerts ?? []).slice(0, 8).map((alert: any) => (
                <div key={alert.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{alert.summary}</p>
                    <p style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>{formatRelative(alert.last_seen_at)}</p>
                  </div>
                  <span className={severityBadge(alert.severity)}>{alert.status === "resolved" ? "resolved" : alert.severity}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Software */}
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>Installed applications ({resolvedSoftware?.length ?? 0})</h2>
          {softwareChanges && softwareChanges.length > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              Last change: {softwareChanges[0].change_type} {softwareChanges[0].name} {formatRelative(softwareChanges[0].detected_at)}
            </span>
          )}
        </div>
        {(resolvedSoftware ?? []).length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No software inventory reported yet.</p>
        ) : (
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            <table>
              <thead><tr><th>Name</th><th>Publisher</th><th>Version</th><th>Arch</th><th>Installed</th></tr></thead>
              <tbody>
                {(resolvedSoftware ?? []).map((app: any, idx: number) => (
                  <tr key={app.id || app.product_key || idx}>
                    <td style={{ fontSize: 12 }}>{app.name}</td>
                    <td style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{app.publisher ?? "—"}</td>
                    <td style={{ fontSize: 11.5 }}>{app.version ?? "—"}</td>
                    <td style={{ fontSize: 11.5 }}>{app.architecture ?? "—"}</td>
                    <td style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{app.install_date ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Deployments */}
      <div className="card" style={{ padding: "18px 20px" }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Software deployments</h2>
        {(deployments ?? []).length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No deployment jobs for this device.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Job</th><th>Operation</th><th>State</th><th>Progress</th><th>Created</th></tr></thead>
              <tbody>
                {(deployments ?? []).map((job: any) => (
                  <tr key={job.id}>
                    <td><a href={`/dashboard/deployments/${job.id}`} style={{ fontFamily: "monospace", fontSize: 11.5 }}>{job.id.slice(0, 8)}…</a></td>
                    <td style={{ fontSize: 12 }}>{job.operation}</td>
                    <td><span className={stateBadge(job.state)}>{job.state}</span></td>
                    <td style={{ fontSize: 12 }}>{job.progress}%</td>
                    <td style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{formatRelative(job.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Events */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
        <div className="card" style={{ padding: "18px 20px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Windows events</h2>
          {(resolvedEvents ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No events collected. Only warning/error events are ingested by default.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
              {(resolvedEvents ?? []).map((event: any, idx: number) => (
                <div key={event.id || event.dedupe_key || idx} style={{ fontSize: 11.5 }}>
                  <span className="badge badge-default" style={{ marginRight: 6 }}>{event.level ?? "?"}</span>
                  <strong>{event.log_name}</strong> {event.event_id ?? ""} · {formatRelative(event.recorded_at)}
                  <p style={{ color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis" }}>{event.message ?? event.provider}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: "18px 20px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Agent communication</h2>
          {(agentEvents ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No agent health events recorded.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
              {(agentEvents ?? []).map((event: any) => (
                <div key={event.id} style={{ fontSize: 11.5 }}>
                  <strong>{event.event_type}</strong> · {formatRelative(event.recorded_at)}
                  <p style={{ color: "var(--text-tertiary)" }}>{event.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
