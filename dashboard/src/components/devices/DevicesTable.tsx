"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { EnrollmentStatus } from "@/types/database";
import { DeviceStatusActions } from "./DeviceStatusActions";
import { Monitor, Wifi, WifiOff, AlertTriangle, PauseCircle, Terminal, ArrowRight } from "lucide-react";
import { motion, type Variants } from "framer-motion";

interface Device {
  id: string;
  display_name: string;
  hostname: string | null;
  operating_system: string | null;
  agent_version: string | null;
  enrollment_status: EnrollmentStatus;
  status_reason: string | null;
  service_status: string | null;
  is_elevated: boolean | null;
  last_seen_at: string | null;
  created_at: string;
  isOnline: boolean;
}

interface Props {
  devices: Device[];
  canManage: boolean;
  organizationId: string;
}

function EnrollmentBadge({ status }: { status: EnrollmentStatus }) {
  if (status === "enrolled") {
    return (
      <span
        className="badge"
        style={{
          color: "var(--status-online)",
          background: "rgba(52,211,153,0.08)",
          borderColor: "rgba(52,211,153,0.25)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-online)" }} />
        Enrolled
      </span>
    );
  }
  if (status === "revoked") {
    return (
      <span
        className="badge"
        style={{
          color: "var(--status-error)",
          background: "rgba(248,113,113,0.08)",
          borderColor: "rgba(248,113,113,0.25)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-error)" }} />
        Revoked
      </span>
    );
  }
  if (status === "suspended") {
    return (
      <span
        className="badge"
        style={{
          color: "var(--status-warning)",
          background: "rgba(251,191,36,0.08)",
          borderColor: "rgba(251,191,36,0.25)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--status-warning)" }} />
        Suspended
      </span>
    );
  }
  if (status === "unauthorized") {
    return (
      <span
        className="badge"
        style={{
          color: "var(--text-secondary)",
          background: "rgba(255,255,255,0.08)",
          borderColor: "rgba(255,255,255,0.20)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--text-secondary)" }} />
        Pending Auth
      </span>
    );
  }
  return (
    <span
      className="badge"
      style={{
        color: "var(--text-tertiary)",
        background: "rgba(255,255,255,0.04)",
        borderColor: "var(--border-subtle)",
      }}
    >
      Pending
    </span>
  );
}

const rowVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] },
  }),
};

export function DevicesTable({ devices, canManage }: Props) {
  if (devices.length === 0) {
    return (
      <div className="card" style={{ padding: "48px 24px", textAlign: "center" }}>
        <Monitor style={{ width: 36, height: 36, color: "var(--text-tertiary)", margin: "0 auto 12px" }} />
        <p style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>No devices enrolled</p>
        <p style={{ color: "var(--text-tertiary)", fontSize: 12, marginTop: 4, maxWidth: 400, margin: "4px auto 0" }}>
          Run the agent installer on any prospective Windows PC. It registers automatically and reports hostname, OS, and status.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Hostname / OS</th>
              <th>Agent & Service</th>
              <th>Status</th>
              <th>Last Seen</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device, i) => (
              <motion.tr
                key={device.id}
                custom={i}
                variants={rowVariants}
                initial="hidden"
                animate="visible"
              >
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div
                      style={{
                        position: "relative",
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: "var(--bg-overlay)",
                        border: "1px solid var(--border-subtle)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Monitor style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
                      {device.enrollment_status === "enrolled" && (
                        <span
                          style={{
                            position: "absolute",
                            bottom: -2,
                            right: -2,
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            border: "2px solid var(--bg-elevated)",
                            background: device.isOnline ? "var(--status-online)" : "var(--text-disabled)",
                          }}
                        />
                      )}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <Link
                        href={`/dashboard/devices/${device.id}`}
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          textDecoration: "none",
                          letterSpacing: "-0.01em",
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
                        onMouseLeave={e => (e.currentTarget.style.color = "var(--text-primary)")}
                      >
                        {device.display_name}
                      </Link>
                      <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 2 }}>
                        {device.id.slice(0, 8)}…
                      </p>
                    </div>
                  </div>
                </td>
                <td>
                  <p style={{ fontSize: 13, color: "var(--text-primary)", fontFamily: "monospace" }}>
                    {device.hostname ?? "—"}
                  </p>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    {device.operating_system ?? "—"}
                  </p>
                </td>
                <td>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                    {device.agent_version ? `v${device.agent_version}` : "—"}
                  </p>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    {device.service_status ?? "unknown"}
                    {device.is_elevated ? " · elevated" : " · standard"}
                  </p>
                </td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {device.enrollment_status === "enrolled" ? (
                      device.isOnline ? (
                        <Wifi style={{ width: 13, height: 13, color: "var(--status-online)" }} />
                      ) : (
                        <WifiOff style={{ width: 13, height: 13, color: "var(--text-disabled)" }} />
                      )
                    ) : device.enrollment_status === "suspended" ? (
                      <PauseCircle style={{ width: 13, height: 13, color: "var(--status-warning)" }} />
                    ) : (
                      <AlertTriangle style={{ width: 13, height: 13, color: "var(--status-warning)" }} />
                    )}
                    <EnrollmentBadge status={device.enrollment_status} />
                  </div>
                  {device.status_reason && (
                    <p
                      style={{
                        marginTop: 4,
                        maxWidth: 200,
                        fontSize: 11,
                        color: "var(--text-tertiary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={device.status_reason}
                    >
                      {device.status_reason}
                    </p>
                  )}
                </td>
                <td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {device.last_seen_at
                      ? formatDistanceToNow(new Date(device.last_seen_at), { addSuffix: true })
                      : "Never"}
                  </span>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    enrolled {formatDistanceToNow(new Date(device.created_at), { addSuffix: true })}
                  </p>
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                    {canManage ? (
                      <>
                        {device.enrollment_status === "enrolled" && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Link
                              href={`/dashboard/devices/${device.id}/terminal`}
                              className="btn btn-secondary btn-sm"
                              title={`Open terminal session on ${device.hostname ?? device.display_name}`}
                            >
                              <Terminal style={{ width: 12, height: 12 }} />
                              Terminal
                            </Link>
                            <Link
                              href={`/dashboard/devices/${device.id}`}
                              className="btn btn-ghost btn-sm"
                            >
                              Manage <ArrowRight style={{ width: 12, height: 12 }} />
                            </Link>
                          </div>
                        )}
                        <DeviceStatusActions
                          deviceId={device.id}
                          deviceName={device.display_name}
                          status={device.enrollment_status}
                        />
                      </>
                    ) : (
                      <Link
                        href={`/dashboard/devices/${device.id}`}
                        className="btn btn-ghost btn-sm"
                      >
                        Details <ArrowRight style={{ width: 12, height: 12 }} />
                      </Link>
                    )}
                  </div>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
