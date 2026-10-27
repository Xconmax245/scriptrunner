"use client";

import {
  Monitor,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { motion, type Variants } from "framer-motion";

interface Stats {
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  queuedJobs: number;
  runningJobs: number;
  recentSucceeded: number;
  recentFailed: number;
  unhealthyDevices?: number;
  activeAlerts?: number;
  activeDeployments?: number;
}

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.97 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      delay: i * 0.07,
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1],
    },
  }),
};

export function OverviewStats({ stats }: { stats: Stats }) {
  const cards = [
    {
      label: "Enrolled",
      value: stats.totalDevices,
      icon: Monitor,
      accent: "rgba(255,255,255,0.15)",
      iconColor: "var(--text-primary)",
    },
    {
      label: "Online",
      value: stats.onlineDevices,
      icon: Wifi,
      accent: "rgba(52,211,153,0.15)",
      iconColor: "var(--status-online)",
    },
    {
      label: "Offline",
      value: stats.offlineDevices,
      icon: WifiOff,
      accent: "rgba(255,255,255,0.06)",
      iconColor: "var(--text-tertiary)",
    },
    {
      label: "Queued / Running",
      value: `${stats.queuedJobs} / ${stats.runningJobs}`,
      icon: Clock,
      accent: "rgba(251,191,36,0.12)",
      iconColor: "var(--status-warning)",
    },
    {
      label: "Succeeded",
      value: stats.recentSucceeded,
      icon: CheckCircle2,
      accent: "rgba(52,211,153,0.12)",
      iconColor: "var(--status-online)",
    },
    {
      label: "Failed",
      value: stats.recentFailed,
      icon: XCircle,
      accent: "rgba(248,113,113,0.12)",
      iconColor: "var(--status-error)",
    },
    ...(stats.activeAlerts !== undefined
      ? [{
          label: "Active alerts",
          value: stats.activeAlerts,
          icon: XCircle,
          accent: "rgba(251,191,36,0.12)",
          iconColor: "var(--status-warning)",
        }]
      : []),
    ...(stats.unhealthyDevices !== undefined
      ? [{
          label: "Unhealthy devices",
          value: stats.unhealthyDevices,
          icon: Monitor,
          accent: "rgba(248,113,113,0.10)",
          iconColor: "var(--status-error)",
        }]
      : []),
    ...(stats.activeDeployments !== undefined
      ? [{
          label: "Active deployments",
          value: stats.activeDeployments,
          icon: Clock,
          accent: "rgba(255,255,255,0.08)",
          iconColor: "var(--text-primary)",
        }]
      : []),
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 12,
      }}
    >
      {cards.map((card, i) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.label}
            custom={i}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            whileHover={{ scale: 1.02, transition: { duration: 0.18 } }}
            className="card"
            style={{ padding: "18px 20px", cursor: "default" }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: card.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Icon style={{ width: 18, height: 18, color: card.iconColor }} />
            </div>
            <p
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: "var(--text-primary)",
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              {card.value}
            </p>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                marginTop: 5,
                fontWeight: 400,
              }}
            >
              {card.label}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}
