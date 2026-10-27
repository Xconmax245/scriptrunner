import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext } from "@/lib/rmm/page-auth";
import { OverviewStats } from "@/components/dashboard/OverviewStats";
import { RecentJobs } from "@/components/dashboard/RecentJobs";
import { RecentAudit } from "@/components/dashboard/RecentAudit";
import { PageTransition } from "@/components/layout/PageTransition";
import type { EnrollmentStatus, JobState, ActorType } from "@/types/database";

export const metadata = { title: "Overview" };

export default async function DashboardPage() {
  const admin = await adminPageContext("/dashboard");
  const supabase = createServiceClient();
  const orgId = admin.organizationId;

  let devicesRes: any = { data: [] };
  let jobsRes: any = { data: [] };
  let auditRes: any = { data: [] };
  let alertsRes: any = { data: [] };
  let deploymentsRes: any = { data: [] };
  let monitorStateRes: any = { data: [] };

  try {
    const results = await Promise.all([
      supabase
        .from("devices")
        .select("id, enrollment_status, last_seen_at")
        .eq("organization_id", orgId),
      supabase
        .from("jobs")
        .select("id, state, created_at, device_id, devices(display_name)")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("audit_events")
        .select("id, action, actor_type, actor_id, timestamp, metadata")
        .eq("organization_id", orgId)
        .order("timestamp", { ascending: false })
        .limit(10),
      supabase
        .from("alerts")
        .select("id, device_id, severity, status")
        .eq("organization_id", orgId)
        .neq("status", "resolved")
        .limit(500),
      supabase
        .from("deployment_jobs")
        .select("id, state")
        .eq("organization_id", orgId)
        .limit(500),
      supabase
        .from("monitor_state")
        .select("device_id, last_status")
        .in("last_status", ["warning", "critical", "error"])
        .limit(1000),
    ]);
    devicesRes = results[0];
    jobsRes = results[1];
    auditRes = results[2];
    alertsRes = results[3];
    deploymentsRes = results[4];
    monitorStateRes = results[5];
  } catch {
    // Tables may be empty or unmigrated
  }

  const devices = (devicesRes.data ?? []) as Array<{
    id: string;
    enrollment_status: EnrollmentStatus;
    last_seen_at: string | null;
  }>;

  const jobs = ((jobsRes.data ?? []) as any[]).map((j: any) => ({
    id: j.id as string,
    state: j.state as JobState,
    created_at: j.created_at as string,
    device_id: j.device_id as string,
    devices: (Array.isArray(j.devices) ? j.devices[0] : j.devices) as { display_name: string } | null,
  }));

  const auditEvents = (auditRes.data ?? []) as Array<{
    id: string;
    action: string;
    actor_type: ActorType;
    actor_id: string | null;
    timestamp: string;
    metadata: unknown;
  }>;

  const alerts = (alertsRes.data ?? []) as Array<{ id: string; device_id: string; severity: string; status: string }>;
  const deployments = (deploymentsRes.data ?? []) as Array<{ id: string; state: string }>;
  const failingMonitorDevices = (monitorStateRes.data ?? []) as Array<{ device_id: string; last_status: string }>;

  const now = new Date();
  const onlineThresholdMs = 5 * 60 * 1000;
  const onlineCount = devices.filter(
    (d) =>
      d.enrollment_status === "enrolled" &&
      d.last_seen_at &&
      now.getTime() - new Date(d.last_seen_at).getTime() < onlineThresholdMs
  ).length;

  const stats = {
    totalDevices: devices.filter((d) => d.enrollment_status === "enrolled").length,
    onlineDevices: onlineCount,
    offlineDevices: devices.filter((d) => d.enrollment_status === "enrolled").length - onlineCount,
    queuedJobs: jobs.filter((j) => ["queued", "waiting_for_device", "claimed"].includes(j.state)).length,
    runningJobs: jobs.filter((j) => j.state === "running").length,
    recentSucceeded: jobs.filter((j) => j.state === "succeeded").length,
    recentFailed: jobs.filter((j) => ["failed", "timed_out"].includes(j.state)).length,
    activeAlerts: alerts.length,
    activeDeployments: deployments.filter((d) =>
      ["pending", "queued", "downloading", "validating", "installing", "verifying"].includes(d.state)
    ).length,
    unhealthyDevices: new Set([
      ...alerts.filter((a) => a.severity === "critical").map((a) => a.device_id),
      ...failingMonitorDevices.map((m) => m.device_id),
      ...devices
        .filter((d) =>
          d.enrollment_status === "enrolled" &&
          (!d.last_seen_at || now.getTime() - new Date(d.last_seen_at).getTime() >= onlineThresholdMs)
        )
        .map((d) => d.id),
    ]).size,
  };

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <OverviewStats stats={stats} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 20 }}>
          <RecentJobs jobs={jobs as Parameters<typeof RecentJobs>[0]["jobs"]} />
          <RecentAudit events={auditEvents} />
        </div>
      </div>
    </PageTransition>
  );
}
