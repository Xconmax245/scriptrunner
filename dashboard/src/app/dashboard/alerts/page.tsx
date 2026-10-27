import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext, formatRelative, severityBadge, stateBadge } from "@/lib/rmm/page-auth";
import { acknowledgeAlertAction, resolveAlertAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";
import { AlertTriangle, CheckCircle2, Eye } from "lucide-react";

export const metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string }>;
}) {
  const { error, status = "active" } = await searchParams;
  const admin = await adminPageContext("/dashboard/alerts");
  const supabase = createServiceClient();

  let query = supabase
    .from("alerts")
    .select("*, monitors(name, kind), devices(display_name, hostname)")
    .eq("organization_id", admin.organizationId)
    .order("last_seen_at", { ascending: false })
    .limit(200);

  if (status === "active") query = query.in("status", ["open", "acknowledged"]);
  else if (status === "resolved") query = query.eq("status", "resolved");

  const { data: alerts } = await query;

  const counts = {
    active: 0,
    critical: 0,
  };
  for (const alert of alerts ?? []) {
    if (alert.status !== "resolved") counts.active++;
    if (alert.status !== "resolved" && alert.severity === "critical") counts.critical++;
  }

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>Alerts</h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
              {counts.active} active · {counts.critical} critical
            </p>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["active", "resolved", "all"].map((value) => (
              <Link
                key={value}
                href={`/dashboard/alerts?status=${value}`}
                className={`btn btn-sm ${status === value ? "btn-primary" : "btn-secondary"}`}
              >
                {value}
              </Link>
            ))}
          </div>
        </div>

        <Notice error={error} />

        {(alerts ?? []).length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
            <CheckCircle2 style={{ width: 22, height: 22, margin: "0 auto 8px" }} />
            No alerts match this filter.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(alerts ?? []).map((alert: any) => {
              const device = Array.isArray(alert.devices) ? alert.devices[0] : alert.devices;
              const monitor = Array.isArray(alert.monitors) ? alert.monitors[0] : alert.monitors;
              return (
                <div key={alert.id} className="card" style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
                      <AlertTriangle style={{ width: 17, height: 17, color: "var(--status-warning)", flexShrink: 0, marginTop: 2 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className={severityBadge(alert.severity)}>{alert.severity}</span>
                          <span className={stateBadge(alert.status === "open" ? "warning" : alert.status)}>{alert.status}</span>
                          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            {monitor?.name ?? "Monitor"} · {monitor?.kind ?? ""}
                          </span>
                        </div>
                        <p style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{alert.summary}</p>
                        <p style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 3 }}>
                          {device?.hostname ?? device?.display_name ?? "Unknown device"} · first seen {formatRelative(alert.first_seen_at)} · last seen {formatRelative(alert.last_seen_at)}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <Link href={`/dashboard/devices/${alert.device_id}`} className="btn btn-ghost btn-sm">
                        <Eye style={{ width: 12, height: 12 }} /> Device
                      </Link>
                      {alert.status === "open" && (
                        <form action={acknowledgeAlertAction}>
                          <input type="hidden" name="alert_id" value={alert.id} />
                          <button className="btn btn-secondary btn-sm" type="submit">Acknowledge</button>
                        </form>
                      )}
                      {alert.status !== "resolved" && (
                        <form action={resolveAlertAction}>
                          <input type="hidden" name="alert_id" value={alert.id} />
                          <button className="btn btn-primary btn-sm" type="submit">Resolve</button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
