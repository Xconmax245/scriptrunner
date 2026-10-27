import { createServiceClient } from "@/lib/supabase/server";
import Link from "next/link";
import { JobStateBadge } from "@/components/jobs/JobStateBadge";
import { formatDistanceToNow } from "date-fns";
import { PageTransition } from "@/components/layout/PageTransition";
import { Terminal, Plus, ArrowLeft, ArrowRight } from "lucide-react";

export const metadata = { title: "Job History" };

export default async function JobHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; page?: string }>;
}) {
  const { state: stateFilter, page: pageStr } = await searchParams;
  const supabase = createServiceClient();

  let orgId = process.env.DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000001";
  try {
    const { data: orgs } = await supabase.from("organizations").select("id").order("created_at", { ascending: true }).limit(1);
    if (orgs && orgs.length > 0) orgId = orgs[0].id;
  } catch {}

  const PAGE_SIZE = 25;
  const page = Math.max(1, parseInt(pageStr ?? "1", 10));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("jobs")
    .select("id, state, created_at, device_id, description, devices(display_name)", { count: "exact" })
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (stateFilter) {
    query = query.eq("state", stateFilter);
  }

  const { data: jobs, count } = await query;
  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  const stateOptions = [
    "queued", "waiting_for_device", "claimed", "running",
    "succeeded", "failed", "timed_out", "cancelled", "expired",
  ];

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              Execution History
            </h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
              {count ?? 0} total jobs recorded across all nodes
            </p>
          </div>
          <Link href="/dashboard/jobs/new" className="btn btn-primary btn-sm">
            <Plus style={{ width: 13, height: 13 }} />
            New Job
          </Link>
        </div>

        {/* Filter Pills */}
        <div
          className="card"
          style={{
            padding: "8px 12px",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            background: "var(--bg-elevated)",
          }}
        >
          <Link
            href="/dashboard/jobs"
            style={{
              padding: "4px 12px",
              borderRadius: 9999,
              fontSize: 12,
              fontWeight: 500,
              textDecoration: "none",
              background: !stateFilter ? "#ffffff" : "transparent",
              color: !stateFilter ? "#000000" : "var(--text-tertiary)",
              transition: "all 120ms",
            }}
          >
            All
          </Link>
          {stateOptions.map((s) => {
            const active = stateFilter === s;
            return (
              <Link
                key={s}
                href={`/dashboard/jobs?state=${s}`}
                style={{
                  padding: "4px 12px",
                  borderRadius: 9999,
                  fontSize: 12,
                  fontWeight: 500,
                  textDecoration: "none",
                  background: active ? "#ffffff" : "transparent",
                  color: active ? "#000000" : "var(--text-tertiary)",
                  transition: "all 120ms",
                }}
              >
                {s.replace(/_/g, " ")}
              </Link>
            );
          })}
        </div>

        {/* Jobs Table */}
        <div className="card" style={{ overflow: "hidden" }}>
          {(jobs ?? []).length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              No jobs found{stateFilter ? ` with state "${stateFilter}"` : ""}.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Target Node</th>
                    <th>Description</th>
                    <th>Execution State</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs ?? []).map((job: any) => {
                    const deviceObj = Array.isArray(job.devices) ? job.devices[0] : job.devices;
                    const device = deviceObj as { display_name: string } | null;
                    return (
                      <tr key={job.id}>
                        <td>
                          <Link
                            href={`/dashboard/jobs/${job.id}`}
                            style={{
                              fontFamily: "monospace",
                              fontSize: 12,
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              textDecoration: "none",
                            }}
                            onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
                            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-primary)")}
                          >
                            {job.id.slice(0, 8)}…
                          </Link>
                        </td>
                        <td>
                          <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>
                            {device?.display_name ?? "—"}
                          </span>
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--text-tertiary)",
                              maxWidth: 320,
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {job.description ?? "—"}
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
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              Page {page} of {totalPages} ({count} total)
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              {page > 1 && (
                <Link
                  href={`/dashboard/jobs?page=${page - 1}${stateFilter ? `&state=${stateFilter}` : ""}`}
                  className="btn btn-secondary btn-sm"
                >
                  <ArrowLeft style={{ width: 12, height: 12 }} />
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={`/dashboard/jobs?page=${page + 1}${stateFilter ? `&state=${stateFilter}` : ""}`}
                  className="btn btn-primary btn-sm"
                >
                  Next
                  <ArrowRight style={{ width: 12, height: 12 }} />
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
