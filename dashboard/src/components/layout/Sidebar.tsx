"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Terminal,
  Monitor,
  Play,
  History,
  Settings,
  Shield,
  ChevronDown,
  LogOut,
  Building2,
  Activity,
  Bell,
  Package,
  Rocket,
  FolderTree,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";

interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface SidebarProps {
  organizations: Organization[];
  userEmail: string;
}

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/dashboard/terminal", label: "Terminal", icon: Terminal },
  { href: "/dashboard/devices", label: "Devices", icon: Monitor },
  { href: "/dashboard/monitoring", label: "Monitoring", icon: Activity },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
  { href: "/dashboard/software", label: "Software", icon: Package },
  { href: "/dashboard/deployments", label: "Deployments", icon: Rocket },
  { href: "/dashboard/groups", label: "Device Groups", icon: FolderTree },
  { href: "/dashboard/jobs/new", label: "New Job", icon: Play, exact: true },
  { href: "/dashboard/jobs", label: "Job History", icon: History },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

const sidebarVariants: Variants = {
  hidden: { x: -20, opacity: 0 },
  visible: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
  },
};

const navItemVariants: Variants = {
  hidden: { x: -12, opacity: 0 },
  visible: (i: number) => ({
    x: 0,
    opacity: 1,
    transition: { delay: 0.12 + i * 0.05, duration: 0.3, ease: [0.22, 1, 0.36, 1] },
  }),
};

export function Sidebar({ organizations, userEmail }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [orgOpen, setOrgOpen] = useState(false);
  const [activeOrg] = useState(organizations[0]);

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href;
    if (href === "/dashboard/jobs") {
      // Job History should only match /dashboard/jobs and /dashboard/jobs/[id], but NOT /dashboard/jobs/new
      return pathname === "/dashboard/jobs" || (pathname.startsWith("/dashboard/jobs/") && pathname !== "/dashboard/jobs/new");
    }
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  };

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
      await fetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Ignore network errors on logout
    }
    router.push("/auth/sign-in");
    router.refresh();
  };

  const avatarLetter = userEmail.charAt(0).toUpperCase();

  return (
    <motion.aside
      variants={sidebarVariants}
      initial="hidden"
      animate="visible"
      style={{
        width: 232,
        flexShrink: 0,
        backgroundColor: "var(--bg-surface)",
        borderRight: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: "20px 16px 18px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Shield style={{ width: 16, height: 16, color: "#000000" }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
            ScriptRunner
          </p>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>Admin Console</p>
        </div>
      </div>

      {/* Org selector */}
      {activeOrg && (
        <div style={{ padding: "10px 10px 6px", borderBottom: "1px solid var(--border-subtle)" }}>
          <button
            onClick={() => setOrgOpen(!orgOpen)}
            aria-expanded={orgOpen}
            aria-label="Select organization"
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              borderRadius: 8,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              transition: "background 120ms",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-overlay)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <Building2 style={{ width: 14, height: 14, color: "var(--text-tertiary)", flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeOrg.name}
            </span>
            <motion.div animate={{ rotate: orgOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <ChevronDown style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
            </motion.div>
          </button>

          <AnimatePresence>
            {orgOpen && organizations.length > 1 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                style={{ overflow: "hidden" }}
              >
                <div
                  style={{
                    marginTop: 4,
                    borderRadius: 8,
                    border: "1px solid var(--border-default)",
                    background: "var(--bg-overlay)",
                    overflow: "hidden",
                  }}
                >
                  {organizations.map(org => (
                    <button
                      key={org.id}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        transition: "background 120ms",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      {org.name}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Navigation */}
      <nav
        style={{ flex: 1, padding: "10px 10px", overflowY: "auto" }}
        aria-label="Main navigation"
      >
        <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 8px 8px" }}>
          Menu
        </p>
        {navItems.map((item, i) => {
          const Icon = item.icon;
          const active = isActive(item.href, item.exact);
          return (
            <motion.div
              key={item.href}
              custom={i}
              variants={navItemVariants}
              initial="hidden"
              animate="visible"
            >
              <Link
                href={item.href}
                className={`nav-item ${active ? "nav-item-active" : ""}`}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  marginBottom: 4,
                  position: "relative",
                  textDecoration: "none",
                }}
              >
                <Icon
                  style={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    color: active ? "var(--text-primary)" : "var(--text-tertiary)",
                    transition: "color 120ms",
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: active ? 600 : 450,
                    color: active ? "var(--text-primary)" : "var(--text-tertiary)",
                    transition: "color 120ms",
                  }}
                >
                  {item.label}
                </span>
                {active && (
                  <motion.div
                    layoutId="active-pill"
                    style={{
                      position: "absolute",
                      right: 12,
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--text-primary)",
                      boxShadow: "0 0 6px rgba(255,255,255,0.4)",
                    }}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </Link>
            </motion.div>
          );
        })}
      </nav>

      {/* User section */}
      <div style={{ padding: "12px 10px 24px", borderTop: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-primary)",
              flexShrink: 0,
            }}
          >
            {avatarLetter}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {userEmail}
            </p>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          id="sign-out-btn"
          className="nav-item"
          style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10, width: "100%", color: "#f87171", background: "transparent", border: "1px solid transparent", cursor: "pointer", padding: "7px 10px", borderRadius: 8 }}
          onMouseEnter={e => {
            e.currentTarget.style.background = "rgba(239,68,68,0.08)";
            e.currentTarget.style.color = "#fca5a5";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "#f87171";
          }}
        >
          <LogOut style={{ width: 14, height: 14, flexShrink: 0 }} />
          Sign out
        </button>
      </div>
    </motion.aside>
  );
}
