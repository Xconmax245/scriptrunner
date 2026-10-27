"use client";

import Link from "next/link";
import { JobStateBadge } from "@/components/jobs/JobStateBadge";
import { formatDistanceToNow } from "date-fns";
import type { JobState } from "@/types/database";
import { motion, type Variants } from "framer-motion";
import { ArrowRight } from "lucide-react";

interface Job {
  id: string;
  state: JobState;
  created_at: string;
  device_id: string;
  devices: { display_name: string } | null;
}

const listVariants = {
  visible: { transition: { staggerChildren: 0.06 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
};

export function RecentJobs({ jobs }: { jobs: Job[] }) {
  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.42, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
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
          Recent Jobs
        </h2>
        <Link
          href="/dashboard/jobs"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            color: "var(--text-tertiary)",
            textDecoration: "none",
            transition: "color 120ms",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={e => (e.currentTarget.style.color = "var(--text-tertiary)")}
        >
          View all <ArrowRight style={{ width: 12, height: 12 }} />
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div
          style={{
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--text-tertiary)",
            fontSize: 13,
          }}
        >
          No jobs yet. Submit a job from the New Job page.
        </div>
      ) : (
        <motion.ul
          variants={listVariants}
          initial="hidden"
          animate="visible"
          style={{ listStyle: "none" }}
        >
          {jobs.slice(0, 6).map(job => (
            <motion.li key={job.id} variants={itemVariants}>
              <Link
                href={`/dashboard/jobs/${job.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 20px",
                  borderBottom: "1px solid var(--border-subtle)",
                  textDecoration: "none",
                  transition: "background 120ms",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-overlay)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p
                    style={{
                      fontSize: 12,
                      fontFamily: "monospace",
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {job.id.slice(0, 8)}…
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {job.devices?.display_name ?? job.device_id.slice(0, 8)}
                  </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 12 }}>
                  <JobStateBadge state={job.state} />
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                    {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                  </span>
                </div>
              </Link>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </motion.div>
  );
}
