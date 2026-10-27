"use client";

import { usePathname } from "next/navigation";
import { RefreshCw, Radio } from "lucide-react";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { motion } from "framer-motion";

const routeTitles: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/terminal": "Terminal",
  "/dashboard/devices": "Devices",
  "/dashboard/jobs": "Job History",
  "/dashboard/jobs/new": "New Job",
  "/dashboard/settings": "Settings",
};

function getTitle(pathname: string): string {
  if (routeTitles[pathname]) return routeTitles[pathname];
  if (pathname.startsWith("/dashboard/devices/")) return "Device Details";
  if (pathname.startsWith("/dashboard/jobs/") && pathname !== "/dashboard/jobs/new") return "Job Details";
  return "Dashboard";
}

export function TopBar() {
  const pathname = usePathname();
  const title = getTitle(pathname);
  const { isRealtimeConnected, isRefreshing, manualRefresh } = useRealtimeSync();

  return (
    <motion.header
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      style={{
        height: 52,
        borderBottom: "1px solid var(--border-subtle)",
        background: "rgba(10,10,10,0.85)",
        backdropFilter: "blur(20px) saturate(160%)",
        WebkitBackdropFilter: "blur(20px) saturate(160%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <motion.h1
          key={title}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25 }}
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </motion.h1>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Realtime Status Pill */}
        <div
          title={
            isRealtimeConnected
              ? "Supabase Realtime connected — updates stream instantly."
              : "Polling fallback active (every 12s)."
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 9999,
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-overlay)",
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--text-tertiary)",
          }}
        >
          <motion.div
            animate={{ opacity: isRealtimeConnected ? [1, 0.4, 1] : 1 }}
            transition={{ repeat: isRealtimeConnected ? Infinity : 0, duration: 2 }}
          >
            <Radio
              style={{
                width: 11,
                height: 11,
                color: isRealtimeConnected ? "var(--status-online)" : "var(--status-warning)",
              }}
            />
          </motion.div>
          <span>{isRealtimeConnected ? "Live" : "Polling"}</span>
        </div>

        {/* Refresh button */}
        <button
          onClick={() => manualRefresh()}
          disabled={isRefreshing}
          id="topbar-refresh-btn"
          title="Force manual refresh"
          aria-label="Refresh"
          className="btn-icon"
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <motion.div
            animate={{ rotate: isRefreshing ? 360 : 0 }}
            transition={{ repeat: isRefreshing ? Infinity : 0, duration: 0.8, ease: "linear" }}
          >
            <RefreshCw style={{ width: 13, height: 13 }} />
          </motion.div>
        </button>
      </div>
    </motion.header>
  );
}
