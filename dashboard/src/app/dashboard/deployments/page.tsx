import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext, formatRelative, stateBadge } from "@/lib/rmm/page-auth";
import { cancelDeploymentAction, retryDeploymentAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";
import { Rocket } from "lucide-react";

export const metadata = { title: "Deployments" };
export const dynamic = "force-dynamic";

const ACTIVE = ["pending", "queued", "downloading", "validating", "installing", "verifying"];
const TERMINAL = ["succeeded", "failed", "cancelled", "expired", "reboot_required", "blocked"];

export default async function DeploymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; state?: string }>;
}) {
  const { error, state = "all" } = await searchParams;
  const admin = await adminPageContext("/dashboard/deployments");
  const supabase = createServiceClient();

  let query = supabase
    .from("deployment_jobs")
    .select("*")
    .eq("organization_id", admin.organizationId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (state === "active") query = query.in("state", ACTIVE);
  else if (state === "failed") query = query.in("state", ["failed", "blocked"]);
  else if (state === "complete") query = query.in("state", TERMINAL);

  const [{ data: jobs }, { data: devices }, { data: versions }, { data: packages }] = await Promise.all([
    query,
    supabase.from("devices").select("id, hostname, display_name").eq("organization_id", admin.organizationId),
    supabase
      .from("software_package_versions")
      .select("id, version, package_id, package_format")
      .eq("organization_id", admin.organizationId),
    supabase.from("software_packages").select("id, name").eq("organization_id", admin.organizationId),
  ]);

  const deviceName = (id: string) => {
    const device = (devices ?? []).find((d: any) => d.id === id);
    return device?.hostname ?? device?.display_name ?? id.slice(0, 8);
  };
  const packageLabel = (versionId: string) => {
    const version = (versions ?? []).find((v: any) => v.id === versionId);
    const pkg = (packages ?? []).find((p: any) => p.id === version?.package_id);
    return `${pkg?.name ?? "Package"} ${version?.version ?? ""}`;
  };

  const counts = {
    active: (jobs ?? []).filter((j: any) => ACTIVE.includes(j.state)).length,
    failed: (jobs ?? []).filter((j: any) => ["failed", "blocked"].includes(j.state)).length,
    complete: (jobs ?? []).filter((j: any) => j.state === "succeeded").length,
  };

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>Deployments</h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
              {counts.active} active · {counts.complete} succeeded · {counts.failed} failed/blocked
            </p>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["all", "active", "failed", "complete"].map((value) => (
              <Link
                key={value}
                href={`/dashboard/deployments?state=${value}`}
                className={`btn btn-sm ${state === value ? "btn-primary" : "btn-secondary"}`}
              >
                {value}
              </Link>
            ))}
          </div>
        </div>

        <Notice error={error} />

        {(jobs ?? []).length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>
            <Rocket style={{ width: 22, height: 22, margin: "0 auto 8px" }} />
            No deployment jobs match this filter.
          </div>
        ) : (
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Package</th><th>Device</th><th>Operation</th><th>State</th>
                    <th>Progress</th><th>Attempts</th><th>Created</th><th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs ?? []).map((job: any) => (
                    <tr key={job.id}>
                      <td>
                        <Link href={`/dashboard/deployments/${job.id}`} style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          {packageLabel(job.package_version_id)}
                        </Link>
                      </td>
                      <td style={{ fontSize: 12 }}>{deviceName(job.device_id)}</td>
                      <td><span className="badge badge-default">{job.operation}</span></td>
                      <td><span className={stateBadge(job.state)}>{job.state.replaceAll("_", " ")}</span></td>
                      <td style={{ minWidth: 130 }}>
                        <div style={{ height: 6, background: "var(--bg-overlay)", borderRadius: 4, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${Math.min(100, Math.max(0, Number(job.progress) || 0))}%`,
                              height: "100%",
                              background: job.state === "failed" ? "var(--status-error)" : "var(--status-online)",
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>{job.progress}%</span>
                      </td>
                      <td style={{ fontSize: 12 }}>{job.attempts}/{job.max_attempts}</td>
                      <td style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{formatRelative(job.created_at)}</td>
                      <td>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                          <Link href={`/dashboard/deployments/${job.id}`} className="btn btn-ghost btn-sm">Details</Link>
                          {ACTIVE.includes(job.state) && (
                            <form action={cancelDeploymentAction}>
                              <input type="hidden" name="job_id" value={job.id} />
                              <input type="hidden" name="return_path" value="/dashboard/deployments" />
                              <button className="btn btn-danger btn-sm" type="submit">Cancel</button>
                            </form>
                          )}
                          {job.state === "failed" && job.attempts < job.max_attempts && (
                            <form action={retryDeploymentAction}>
                              <input type="hidden" name="job_id" value={job.id} />
                              <input type="hidden" name="return_path" value="/dashboard/deployments" />
                              <button className="btn btn-secondary btn-sm" type="submit">Retry</button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
