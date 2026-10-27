import { createServiceClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth/authorization";
import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { JobStateBadge } from "@/components/jobs/JobStateBadge";
import { DeviceStatusActions } from "@/components/devices/DeviceStatusActions";
import { DeviceRmmPanels } from "@/components/devices/DeviceRmmPanels";
import { PageTransition } from "@/components/layout/PageTransition";
import {
  Monitor,
  Play,
  ArrowLeft,
  Terminal,
  ShieldCheck,
  ArrowRight,
  Package,
} from "lucide-react";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DeviceDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = createServiceClient();
  const user = await getAuthenticatedUser();

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("*")
    .eq("id", id)
    .single();

  if (deviceError || !device) {
    notFound();
  }

  let canManage = true;
  if (user) {
    const { data: membership } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", device.organization_id)
      .eq("user_id", user.id)
      .maybeSingle();
    canManage = !membership || membership.role === "owner" || membership.role === "administrator";
  }

  const { data: recentJobs } = await supabase
    .from("jobs")
    .select("id, script_type, state, created_at, started_at, completed_at, timeout_seconds")
    .eq("device_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  const isOnline =
    device.last_seen_at &&
    new Date(device.last_seen_at).getTime() > Date.now() - 90 * 1000;

  const isRevoked = device.enrollment_status === "revoked";

  return (
    <PageTransition>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Navigation Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/dashboard/devices" className="btn btn-ghost btn-sm">
            <ArrowLeft style={{ width: 13, height: 13 }} />
            Devices
          </Link>
          <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>/</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-tertiary)" }}>
            {device.id}
          </span>
        </div>

        {/* Header Bar */}
        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
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
                <Monitor style={{ width: 20, height: 20, color: "var(--text-primary)" }} />
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <h1 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
                    {device.hostname ?? device.display_name}
                  </h1>
                  {isRevoked ? (
                    <span className="badge" style={{ color: "var(--status-error)", background: "rgba(248,113,113,0.10)", borderColor: "rgba(248,113,113,0.25)" }}>
                      Revoked
                    </span>
                  ) : isOnline ? (
                    <span className="badge" style={{ color: "var(--status-online)", background: "rgba(52,211,153,0.10)", borderColor: "rgba(52,211,153,0.25)" }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-online)" }} />
                      Online
                    </span>
                  ) : (
                    <span className="badge" style={{ color: "var(--text-tertiary)", background: "rgba(255,255,255,0.04)", borderColor: "var(--border-subtle)" }}>
                      Offline
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 2 }}>
                  {device.display_name} &middot; {device.id}
                </p>
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {device.enrollment_status === "enrolled" && canManage && (
                <Link
                  href={`/dashboard/devices/${device.id}/terminal`}
                  className="btn btn-secondary btn-sm"
                >
                  <Terminal style={{ width: 13, height: 13 }} />
                  Remote Terminal
                </Link>
              )}
              {!isRevoked && canManage && (
                <Link
                  href={`/dashboard/software?device=${device.id}`}
                  className="btn btn-secondary btn-sm"
                >
                  <Package style={{ width: 13, height: 13 }} />
                  Deploy Software
                </Link>
              )}
              {!isRevoked && canManage && (
                <Link
                  href={`/dashboard/jobs/new?device=${device.id}`}
                  className="btn btn-primary btn-sm"
                >
                  <Play style={{ width: 13, height: 13 }} />
                  Execute Script
                </Link>
              )}
              {canManage ? (
                <DeviceStatusActions
                  deviceId={device.id}
                  deviceName={device.display_name}
                  status={device.enrollment_status}
                />
              ) : (
                <Link href="/auth/sign-in" className="btn btn-secondary btn-sm">
                  <ShieldCheck style={{ width: 13, height: 13 }} />
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Telemetry Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <div className="card" style={{ padding: "16px 20px" }}>
            <p className="label">Operating System</p>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {device.operating_system || "Windows (x64)"}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Architecture: x64</p>
          </div>

          <div className="card" style={{ padding: "16px 20px" }}>
            <p className="label">Agent & Service</p>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              v{device.agent_version || "1.0.0"} &middot; {device.service_status ?? (device.metadata as any)?.service_status ?? "running"}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              {(device.is_elevated ?? (device.metadata as any)?.is_elevated) ? "Elevated SYSTEM" : "Standard user"}
            </p>
          </div>

          <div className="card" style={{ padding: "16px 20px" }}>
            <p className="label">Heartbeat / Last Seen</p>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {device.last_seen_at
                ? formatDistanceToNow(new Date(device.last_seen_at), { addSuffix: true })
                : "Never"}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              {device.last_seen_at ? format(new Date(device.last_seen_at), "yyyy-MM-dd HH:mm:ss") : "No connection"}
            </p>
          </div>

          <div className="card" style={{ padding: "16px 20px" }}>
            <p className="label">Provisioned</p>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {format(new Date(device.created_at), "yyyy-MM-dd")}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2, fontFamily: "monospace" }}>
              Auth: Managed Org Key
            </p>
          </div>
        </div>

        {/* RMM panels: health, inventory, telemetry, monitors, software, deployments */}
        <DeviceRmmPanels deviceId={device.id} organizationId={device.organization_id} />

        {/* Execution History */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              Node Execution History
            </h2>
            <Link
              href={`/dashboard/jobs?device=${device.id}`}
              className="btn btn-ghost btn-sm"
            >
              View all <ArrowRight style={{ width: 12, height: 12 }} />
            </Link>
          </div>

          {!recentJobs || recentJobs.length === 0 ? (
            <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              No jobs recorded for this node yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Execution Status</th>
                    <th>Queued</th>
                    <th>Elapsed</th>
                    <th style={{ textAlign: "right" }}>Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((job) => {
                    let durationStr = "-";
                    if (job.started_at && job.completed_at) {
                      const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
                      durationStr = `${(ms / 1000).toFixed(1)}s`;
                    }

                    return (
                      <tr key={job.id}>
                        <td>
                          <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-secondary)" }}>
                            {job.id.substring(0, 8)}…
                          </span>
                        </td>
                        <td>
                          <JobStateBadge state={job.state} />
                        </td>
                        <td>
                          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)" }}>
                            {durationStr}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <Link href={`/dashboard/jobs/${job.id}`} className="btn btn-ghost btn-sm">
                            Details <ArrowRight style={{ width: 12, height: 12 }} />
                          </Link>
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
