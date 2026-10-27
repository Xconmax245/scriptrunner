import { notFound } from "next/navigation";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext, formatWhen, stateBadge } from "@/lib/rmm/page-auth";
import { cancelDeploymentAction, retryDeploymentAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const ACTIVE = ["pending", "queued", "downloading", "validating", "installing", "verifying"];

export default async function DeploymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const admin = await adminPageContext(`/dashboard/deployments/${id}`);
  const supabase = createServiceClient();

  const { data: job } = await supabase
    .from("deployment_jobs")
    .select("*")
    .eq("id", id)
    .eq("organization_id", admin.organizationId)
    .maybeSingle();

  if (!job) notFound();

  const [{ data: device }, { data: version }, { data: attempts }] = await Promise.all([
    supabase.from("devices").select("id, hostname, display_name, operating_system").eq("id", job.device_id).maybeSingle(),
    supabase
      .from("software_package_versions")
      .select("*, software_packages(name, publisher)")
      .eq("id", job.package_version_id)
      .maybeSingle(),
    supabase
      .from("deployment_attempts")
      .select("*")
      .eq("job_id", job.id)
      .order("attempt_number", { ascending: true }),
  ]);

  const pkg = Array.isArray(version?.software_packages)
    ? version?.software_packages[0]
    : version?.software_packages;

  return (
    <PageTransition>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Link href="/dashboard/deployments" className="btn btn-ghost btn-sm">
            <ArrowLeft style={{ width: 13, height: 13 }} /> Deployments
          </Link>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-tertiary)" }}>{job.id}</span>
        </div>

        <Notice error={error} />

        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: 17, fontWeight: 700 }}>
                {pkg?.name ?? "Package"} {version?.version}
              </h1>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>
                {job.operation} on {device?.hostname ?? device?.display_name ?? job.device_id}
              </p>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
              <span className={stateBadge(job.state)}>{job.state.replaceAll("_", " ")}</span>
              {ACTIVE.includes(job.state) && (
                <form action={cancelDeploymentAction}>
                  <input type="hidden" name="job_id" value={job.id} />
                  <input type="hidden" name="return_path" value={`/dashboard/deployments/${job.id}`} />
                  <button className="btn btn-danger btn-sm" type="submit">Cancel</button>
                </form>
              )}
              {job.state === "failed" && job.attempts < job.max_attempts && (
                <form action={retryDeploymentAction}>
                  <input type="hidden" name="job_id" value={job.id} />
                  <input type="hidden" name="return_path" value={`/dashboard/deployments/${job.id}`} />
                  <button className="btn btn-secondary btn-sm" type="submit">Retry</button>
                </form>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 18 }}>
            {[
              ["Progress", `${job.progress}%`],
              ["Attempts", `${job.attempts}/${job.max_attempts}`],
              ["Exit code", job.exit_code ?? "—"],
              ["Reboot required", job.reboot_required ? "Yes" : "No"],
              ["Scheduled", formatWhen(job.scheduled_for)],
              ["Started", formatWhen(job.started_at)],
              ["Completed", formatWhen(job.completed_at)],
              ["SHA-256", version ? String(version.sha256).slice(0, 16) + "…" : "—"],
            ].map(([label, value]) => (
              <div key={label} style={{ background: "var(--bg-overlay)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "10px 12px" }}>
                <p className="label" style={{ marginBottom: 2 }}>{label}</p>
                <p style={{ fontSize: 12.5, fontFamily: label === "SHA-256" ? "monospace" : undefined }}>{value}</p>
              </div>
            ))}
          </div>

          {job.error_summary && (
            <div style={{ marginTop: 14, padding: "10px 12px", border: "1px solid rgba(248,113,113,0.25)", background: "rgba(248,113,113,0.08)", borderRadius: "var(--radius-md)", fontSize: 12.5 }}>
              <strong>Failure:</strong> {job.error_summary}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: "20px 24px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Execution attempts</h2>
          {(attempts ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No attempts recorded.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(attempts ?? []).map((attempt: any) => (
                <div key={attempt.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 12px", background: "var(--bg-overlay)", fontSize: 12 }}>
                    <span>Attempt #{attempt.attempt_number} · <span className={stateBadge(attempt.state)}>{attempt.state}</span></span>
                    <span style={{ color: "var(--text-tertiary)" }}>exit {attempt.exit_code ?? "—"} · {formatWhen(attempt.completed_at)}</span>
                  </div>
                  <pre className="code-block" style={{ margin: 0, maxHeight: 260, overflow: "auto", fontSize: 11.5 }}>
                    {attempt.output || attempt.error_summary || "No diagnostic output recorded."}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: "20px 24px" }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Job output</h2>
          <pre className="code-block" style={{ margin: 0, maxHeight: 320, overflow: "auto", fontSize: 11.5 }}>
            {job.stdout_text || job.stderr_text || "No output captured."}
          </pre>
        </div>
      </div>
    </PageTransition>
  );
}
