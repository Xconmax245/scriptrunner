import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { JobStateBadge } from "@/components/jobs/JobStateBadge";
import { JobDetailsClient } from "@/components/jobs/JobDetailsClient";
import { formatDistanceToNow, format } from "date-fns";
import Link from "next/link";
import { ArrowLeft, Terminal, Clock, ShieldCheck, Cpu } from "lucide-react";
import { PageTransition } from "@/components/layout/PageTransition";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Job ${id.slice(0, 8)}` };
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  let user: { id: string } | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {}

  let canCancel = true;
  if (user) {
    try {
      const { data: membership } = await supabase
        .from("organization_members")
        .select("organization_id, role")
        .eq("user_id", user.id)
        .limit(1)
        .single();
      canCancel = !membership || ["owner", "administrator", "operator"].includes(membership.role);
    } catch {}
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("*, devices(display_name, hostname)")
    .eq("id", id)
    .single();

  if (!job) {
    return (
      <div style={{ textAlign: "center", padding: "64px 20px" }}>
        <p style={{ color: "var(--text-tertiary)" }}>Job not found or access restricted.</p>
        <Link href="/dashboard/jobs" className="btn btn-secondary btn-sm" style={{ marginTop: 16 }}>
          Return to History
        </Link>
      </div>
    );
  }

  const { data: attempts } = await supabase
    .from("job_attempts")
    .select("*")
    .eq("job_id", id)
    .order("attempt_number", { ascending: true });

  const canAdmin = true;
  const device = job.devices as { display_name: string; hostname: string | null } | null;

  let duration: string | null = null;
  if (job.started_at && job.completed_at) {
    const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
    duration = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <PageTransition>
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Navigation Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/dashboard/jobs" className="btn btn-ghost btn-sm">
            <ArrowLeft style={{ width: 13, height: 13 }} />
            Job History
          </Link>
          <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>/</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-tertiary)" }}>
            {job.id}
          </span>
        </div>

        {/* Primary Status Card */}
        <div className="card" style={{ padding: "24px 28px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <JobStateBadge state={job.state} />
                <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  Created {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                </span>
              </div>
              {job.description && (
                <p style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>
                  {job.description}
                </p>
              )}
              {job.change_ticket && (
                <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Ticket: {job.change_ticket}</p>
              )}
            </div>
            {canAdmin && (
              <JobDetailsClient
                jobId={job.id}
                organizationId={job.organization_id}
                state={job.state}
              />
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
              marginTop: 20,
              paddingTop: 20,
              borderTop: "1px solid var(--border-subtle)",
            }}
          >
            <div>
              <p className="label">Target Endpoint</p>
              <p style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                {device?.display_name ?? "—"}
              </p>
              {device?.hostname && (
                <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
                  {device.hostname}
                </p>
              )}
            </div>
            <div>
              <p className="label">Script SHA-256</p>
              <p style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)" }}>
                {job.script_hash.slice(0, 16)}…
              </p>
            </div>
            <div>
              <p className="label">Execution Timeout</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>{job.timeout_seconds}s</p>
            </div>
            <div>
              <p className="label">Total Elapsed</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>{duration ?? "—"}</p>
            </div>
            <div>
              <p className="label">Queued At</p>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                {format(new Date(job.created_at), "PPpp")}
              </p>
            </div>
            <div>
              <p className="label">Expires At</p>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                {format(new Date(job.expires_at), "PPpp")}
              </p>
            </div>
            {job.started_at && (
              <div>
                <p className="label">Dispatched At</p>
                <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  {format(new Date(job.started_at), "PPpp")}
                </p>
              </div>
            )}
            {job.completed_at && (
              <div>
                <p className="label">Terminated At</p>
                <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  {format(new Date(job.completed_at), "PPpp")}
                </p>
              </div>
            )}
          </div>

          {job.error_summary && (
            <div
              style={{
                marginTop: 18,
                padding: "12px 16px",
                borderRadius: "var(--radius-md)",
                background: "rgba(248,113,113,0.08)",
                border: "1px solid rgba(248,113,113,0.20)",
                color: "var(--status-error)",
                fontSize: 12.5,
              }}
            >
              {job.error_summary}
            </div>
          )}
        </div>

        {/* Script Content */}
        {canAdmin && (
          <div className="card" style={{ padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Terminal style={{ width: 14, height: 14, color: "var(--text-secondary)" }} />
              <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                Command Payload
              </h3>
            </div>
            <pre className="code-block">{job.script_content}</pre>
          </div>
        )}

        {/* Attempts & Execution Stream */}
        {(attempts ?? []).length > 0 && (
          <div className="card" style={{ padding: "20px 24px" }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>
              Execution Attempts & Realtime Output
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(attempts ?? []).map((attempt) => (
                <div
                  key={attempt.id}
                  style={{
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-subtle)",
                    overflow: "hidden",
                    background: "var(--bg-overlay)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 16px",
                      background: "rgba(255,255,255,0.02)",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                        Attempt #{attempt.attempt_number}
                      </span>
                      <JobStateBadge state={attempt.state} />
                      {attempt.exit_code !== null && (
                        <span
                          style={{
                            fontSize: 11,
                            fontFamily: "monospace",
                            color: attempt.exit_code === 0 ? "var(--status-online)" : "var(--status-error)",
                          }}
                        >
                          exit {attempt.exit_code}
                        </span>
                      )}
                    </div>
                    {attempt.completed_at && attempt.started_at && (
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                        {((new Date(attempt.completed_at).getTime() - new Date(attempt.started_at).getTime()) / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>

                  {attempt.stdout_text && (
                    <div style={{ padding: 16, borderBottom: attempt.stderr_text ? "1px solid var(--border-subtle)" : undefined }}>
                      <p className="label" style={{ marginBottom: 6 }}>
                        Standard Output {attempt.stdout_truncated ? "(truncated)" : ""}
                      </p>
                      <pre className="code-block" style={{ color: "#ffffff", background: "#050505" }}>
                        {attempt.stdout_text}
                      </pre>
                    </div>
                  )}

                  {attempt.stderr_text && (
                    <div style={{ padding: 16 }}>
                      <p className="label" style={{ marginBottom: 6, color: "var(--status-error)" }}>
                        Standard Error {attempt.stderr_truncated ? "(truncated)" : ""}
                      </p>
                      <pre className="code-block" style={{ color: "#fca5a5", background: "rgba(239,68,68,0.05)" }}>
                        {attempt.stderr_text}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
