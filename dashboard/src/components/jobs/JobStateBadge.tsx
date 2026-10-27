import type { JobState } from "@/types/database";

const stateConfig: Record<
  JobState,
  { label: string; badgeStyle: React.CSSProperties; dotStyle: React.CSSProperties }
> = {
  queued: {
    label: "Queued",
    badgeStyle: {
      color: "var(--text-secondary)",
      background: "rgba(255,255,255,0.04)",
      borderColor: "var(--border-subtle)",
    },
    dotStyle: { background: "var(--text-tertiary)" },
  },
  waiting_for_device: {
    label: "Waiting",
    badgeStyle: {
      color: "#fbbf24",
      background: "rgba(251,191,36,0.08)",
      borderColor: "rgba(251,191,36,0.20)",
    },
    dotStyle: { background: "#fbbf24" },
  },
  claimed: {
    label: "Claimed",
    badgeStyle: {
      color: "#ffffff",
      background: "rgba(255,255,255,0.08)",
      borderColor: "rgba(255,255,255,0.20)",
    },
    dotStyle: { background: "#ffffff" },
  },
  running: {
    label: "Running",
    badgeStyle: {
      color: "#ffffff",
      background: "rgba(255,255,255,0.12)",
      borderColor: "rgba(255,255,255,0.28)",
    },
    dotStyle: { background: "#ffffff" },
  },
  succeeded: {
    label: "Succeeded",
    badgeStyle: {
      color: "#34d399",
      background: "rgba(52,211,153,0.08)",
      borderColor: "rgba(52,211,153,0.20)",
    },
    dotStyle: { background: "#34d399" },
  },
  failed: {
    label: "Failed",
    badgeStyle: {
      color: "#f87171",
      background: "rgba(248,113,113,0.08)",
      borderColor: "rgba(248,113,113,0.20)",
    },
    dotStyle: { background: "#f87171" },
  },
  timed_out: {
    label: "Timed Out",
    badgeStyle: {
      color: "#fb923c",
      background: "rgba(251,146,60,0.08)",
      borderColor: "rgba(251,146,60,0.20)",
    },
    dotStyle: { background: "#fb923c" },
  },
  cancelled: {
    label: "Cancelled",
    badgeStyle: {
      color: "var(--text-tertiary)",
      background: "rgba(255,255,255,0.03)",
      borderColor: "var(--border-subtle)",
    },
    dotStyle: { background: "var(--text-disabled)" },
  },
  expired: {
    label: "Expired",
    badgeStyle: {
      color: "var(--text-tertiary)",
      background: "rgba(255,255,255,0.03)",
      borderColor: "var(--border-subtle)",
    },
    dotStyle: { background: "var(--text-disabled)" },
  },
  outcome_unknown: {
    label: "Unknown",
    badgeStyle: {
      color: "var(--text-secondary)",
      background: "rgba(255,255,255,0.04)",
      borderColor: "var(--border-subtle)",
    },
    dotStyle: { background: "var(--text-tertiary)" },
  },
};

export function JobStateBadge({ state }: { state: JobState }) {
  const config = stateConfig[state] ?? {
    label: state,
    badgeStyle: {
      color: "var(--text-secondary)",
      background: "rgba(255,255,255,0.04)",
      borderColor: "var(--border-subtle)",
    },
    dotStyle: { background: "var(--text-tertiary)" },
  };

  const isPulsing = state === "running";

  return (
    <span
      className="badge"
      style={{
        ...config.badgeStyle,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 500,
        padding: "3px 8px",
        borderRadius: 9999,
        border: "1px solid",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          display: "inline-block",
          ...config.dotStyle,
          animation: isPulsing ? "pulseDot 1.5s ease-in-out infinite" : undefined,
        }}
      />
      {config.label}
    </span>
  );
}
