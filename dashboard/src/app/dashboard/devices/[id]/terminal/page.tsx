import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth/authorization";
import { WorkingTerminal } from "@/components/terminal/WorkingTerminal";
import { PageTransition } from "@/components/layout/PageTransition";

export const metadata = { title: "Remote Terminal" };
export const dynamic = "force-dynamic";

export default async function TerminalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const service = createServiceClient();

  const { data: device, error } = await service
    .from("devices")
    .select(
      "id, organization_id, display_name, hostname, enrollment_status, last_seen_at, operating_system, agent_version, metadata"
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !device) notFound();

  const user = await getAuthenticatedUser();
  let canManage = true;
  if (user) {
    try {
      const { data: membership } = await service
        .from("organization_members")
        .select("role")
        .eq("organization_id", device.organization_id)
        .eq("user_id", user.id)
        .maybeSingle();
      canManage = !membership || membership?.role === "owner" || membership?.role === "administrator";
    } catch {
      canManage = true;
    }
  }

  const now = Date.now();
  const isOnline =
    !!device.last_seen_at && now - new Date(device.last_seen_at).getTime() < 5 * 60 * 1000;

  const deviceWithStatus = {
    id: device.id,
    display_name: device.display_name,
    hostname: device.hostname,
    operating_system: device.operating_system,
    isOnline,
  };

  const statusReason = (device.metadata as any)?.status_reason ?? null;

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link
            href={`/dashboard/devices/${device.id}`}
            className="btn btn-ghost btn-sm"
            aria-label="Back to device"
          >
            <ArrowLeft style={{ width: 13, height: 13 }} />
            Device Details
          </Link>
          <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>/</span>
          <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)" }}>
            Terminal &middot; {device.hostname ?? device.display_name}
          </span>
        </div>

        {device.enrollment_status !== "enrolled" && canManage && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 16px",
              borderRadius: "var(--radius-md)",
              border: "1px solid rgba(251,191,36,0.25)",
              background: "rgba(251,191,36,0.08)",
              color: "var(--status-warning)",
              fontSize: 12.5,
            }}
          >
            <ShieldAlert style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
            <div>
              <p style={{ fontWeight: 600 }}>This device cannot accept terminal sessions.</p>
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                Current state: <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>{device.enrollment_status}</span>
                {statusReason ? ` — ${statusReason}` : ""}. An administrator must authorize it before sessions can open.
              </p>
            </div>
          </div>
        )}

        <WorkingTerminal
          devices={[deviceWithStatus]}
          initialDeviceId={device.id}
        />
      </div>
    </PageTransition>
  );
}
