"use client";

import { formatDistanceToNow } from "date-fns";
import type { ActorType } from "@/types/database";
import { motion, type Variants } from "framer-motion";
import { Activity, ShieldCheck, Smartphone } from "lucide-react";

interface AuditEvent {
  id: string;
  action: string;
  actor_type: ActorType;
  actor_id: string | null;
  timestamp: string;
  metadata: unknown;
}

const actionLabels: Record<string, string> = {
  "job.submitted": "Job submitted",
  "job.cancelled": "Job cancelled",
  "device.enrolled": "Device enrolled",
  "device.revoked": "Device revoked",
  "enrollment_invitation.created": "Invitation created",
};

const listVariants = {
  visible: { transition: { staggerChildren: 0.05 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
};

export function RecentAudit({ events }: { events: AuditEvent[] }) {
  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.48, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Activity style={{ width: 14, height: 14, color: "var(--text-tertiary)" }} />
          <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            Audit Stream
          </h2>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Realtime Log</span>
      </div>

      {events.length === 0 ? (
        <div
          style={{
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--text-tertiary)",
            fontSize: 13,
          }}
        >
          No audit events recorded yet.
        </div>
      ) : (
        <motion.ul
          variants={listVariants}
          initial="hidden"
          animate="visible"
          style={{ listStyle: "none" }}
        >
          {events.slice(0, 8).map(event => {
            const isDevice = event.actor_type === "device";
            return (
              <motion.li
                key={event.id}
                variants={itemVariants}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 20px",
                  borderBottom: "1px solid var(--border-subtle)",
                  transition: "background 120ms",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-overlay)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: isDevice ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.12)",
                    border: "1px solid var(--border-subtle)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {isDevice ? (
                    <Smartphone style={{ width: 11, height: 11, color: "var(--text-secondary)" }} />
                  ) : (
                    <ShieldCheck style={{ width: 11, height: 11, color: "var(--text-primary)" }} />
                  )}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {actionLabels[event.action] ?? event.action}
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>{isDevice ? "Device Node" : "Administrator"}</span>
                    <span>&middot;</span>
                    <span>
                      {formatDistanceToNow(new Date(event.timestamp), {
                        addSuffix: true,
                      })}
                    </span>
                  </p>
                </div>
              </motion.li>
            );
          })}
        </motion.ul>
      )}
    </motion.div>
  );
}
