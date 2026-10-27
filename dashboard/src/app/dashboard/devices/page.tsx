import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext } from "@/lib/rmm/page-auth";
import { DevicesTable } from "@/components/devices/DevicesTable";
import { EnrollmentPolicyPanel } from "@/components/devices/EnrollmentPolicyPanel";
import { ShieldCheck } from "lucide-react";
import { PageTransition } from "@/components/layout/PageTransition";
import type { Database } from "@/types/database";

// Device columns added by migration 006_device_lifecycle (not yet reflected in
// the generated database types).
type DeviceRow = Database["public"]["Tables"]["devices"]["Row"] & {
  status_reason: string | null;
  service_status: string | null;
  is_elevated: boolean | null;
};

export const metadata = { title: "Devices" };
export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const admin = await adminPageContext("/dashboard/devices");
  const supabase = createServiceClient();
  const orgId = admin.organizationId;

  let devices: DeviceRow[] = [];
  try {
    const { data } = await supabase
      .from("devices")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    devices = data ?? [];
  } catch {
    // Tables may not be populated yet
  }

  const canManage = true;

  const now = Date.now();
  const onlineThresholdMs = 90 * 1000;

  const devicesWithStatus = devices.map((d) => ({
    ...d,
    service_status: d.service_status ?? (d as any).metadata?.service_status ?? "running",
    is_elevated: d.is_elevated ?? (d as any).metadata?.is_elevated ?? false,
    isOnline:
      d.enrollment_status === "enrolled" &&
      !!d.last_seen_at &&
      now - new Date(d.last_seen_at).getTime() < onlineThresholdMs,
  }));

  const enrolledCount = devicesWithStatus.filter(
    (d) => d.enrollment_status === "enrolled"
  ).length;
  const onlineCount = devicesWithStatus.filter((d) => d.isOnline).length;
  const pendingCount = devicesWithStatus.filter(
    (d) => d.enrollment_status === "unauthorized" || d.enrollment_status === "pending"
  ).length;

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header bar */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              Target Devices
            </h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
              {enrolledCount} enrolled &middot; {onlineCount} online
              {pendingCount > 0 && (
                <span
                  style={{
                    marginLeft: 8,
                    borderRadius: 9999,
                    border: "1px solid rgba(251,191,36,0.25)",
                    background: "rgba(251,191,36,0.10)",
                    padding: "2px 8px",
                    color: "var(--status-warning)",
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {pendingCount} awaiting authorization
                </span>
              )}
            </p>
          </div>

          <div>
            {canManage ? (
              <EnrollmentPolicyPanel organizationId={orgId} />
            ) : (
              <a
                href="/auth/sign-in?next=/dashboard/devices"
                className="btn btn-secondary btn-sm"
              >
                <ShieldCheck style={{ width: 13, height: 13 }} />
                Sign in to manage
              </a>
            )}
          </div>
        </div>

        {!canManage && (
          <div
            className="card"
            style={{
              padding: "12px 16px",
              fontSize: 12,
              color: "var(--text-tertiary)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            Device discovery and status are visible across the team. Authorizing, suspending,
            or opening remote terminals requires administrator sign-in.
          </div>
        )}

        <DevicesTable devices={devicesWithStatus} canManage={canManage} organizationId={orgId} />
      </div>
    </PageTransition>
  );
}
