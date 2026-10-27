import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext } from "@/lib/rmm/page-auth";
import { getAllDeployments } from "@/lib/rmm/deploymentStore";
import { DirectDeploymentForm } from "@/components/software/DirectDeploymentForm";
import { PageTransition } from "@/components/layout/PageTransition";
import { Package, ShieldCheck } from "lucide-react";

export const metadata = { title: "Software Deployment" };
export const dynamic = "force-dynamic";

export default async function SoftwarePage({
  searchParams,
}: {
  searchParams: Promise<{ device?: string; error?: string; message?: string }>;
}) {
  const { device: preselectedDeviceId } = await searchParams;
  const admin = await adminPageContext("/dashboard/software");
  const supabase = createServiceClient();

  // Fetch enrolled devices
  const { data: devices } = await supabase
    .from("devices")
    .select("id, hostname, display_name, operating_system, agent_version, last_seen_at, enrollment_status")
    .eq("organization_id", admin.organizationId)
    .eq("enrollment_status", "enrolled")
    .order("hostname");

  const now = Date.now();
  const enrolledDevices = (devices ?? []).map((d) => ({
    id: d.id,
    hostname: d.hostname,
    display_name: d.display_name,
    operating_system: d.operating_system,
    agent_version: d.agent_version,
    isOnline: !!d.last_seen_at && now - new Date(d.last_seen_at).getTime() < 3 * 60 * 1000,
  }));

  // Fetch all recent deployments from persistent deploymentStore
  const allDeployments = await getAllDeployments();

  const totalDeployments = allDeployments.length;
  const succeededCount = allDeployments.filter((d) => d.state === "succeeded").length;
  const activeCount = allDeployments.filter((d) =>
    ["queued", "waiting_for_device", "downloading", "validating", "installing", "verifying"].includes(d.state)
  ).length;
  const failedCount = allDeployments.filter((d) => ["failed", "cancelled"].includes(d.state)).length;

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header with stats */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Package style={{ width: 20, height: 20, color: "#3b82f6" }} />
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
                Software Deployment
              </h1>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
              Direct remote installer execution and verified silent deployment across enrolled Windows endpoints.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
            <div className="card" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-tertiary)" }}>Total:</span>
              <strong>{totalDeployments}</strong>
            </div>
            <div className="card" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#34d399" }}>Succeeded:</span>
              <strong style={{ color: "#34d399" }}>{succeededCount}</strong>
            </div>
            <div className="card" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#60a5fa" }}>In Progress:</span>
              <strong style={{ color: "#60a5fa" }}>{activeCount}</strong>
            </div>
            <div className="card" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#f87171" }}>Failed / Cancelled:</span>
              <strong style={{ color: "#f87171" }}>{failedCount}</strong>
            </div>
          </div>
        </div>

        {/* Unified Direct Deployment Form & Activity Table */}
        <DirectDeploymentForm
          devices={enrolledDevices}
          initialDeployments={allDeployments}
          preselectedDeviceId={preselectedDeviceId}
        />
      </div>
    </PageTransition>
  );
}
