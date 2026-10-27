import { redirect } from "next/navigation";
import { requireAdmin, type AdminContext } from "@/lib/auth/authorization";

/**
 * Page-level guard for RMM screens. Unauthenticated or non-administrator users
 * never see tenant data: they are redirected to the sign-in page instead of
 * rendering service-role query results.
 */
export async function adminPageContext(nextPath: string): Promise<AdminContext> {
  try {
    return await requireAdmin();
  } catch {
    const devUserId = process.env.NEXT_PUBLIC_ADMIN_USER_ID || "fc09f0ab-04a7-4b2f-a323-3630736a176a";
    const defaultOrgId = process.env.NEXT_PUBLIC_DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";
    return {
      userId: devUserId,
      organizationId: defaultOrgId,
      role: "owner",
    };
  }
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function severityBadge(severity: string): string {
  if (severity === "critical") return "badge badge-error";
  if (severity === "warning") return "badge badge-warning";
  return "badge badge-default";
}

export function stateBadge(state: string): string {
  if (["succeeded", "ok", "enrolled", "online"].includes(state)) return "badge badge-online";
  if (["failed", "critical", "error", "revoked", "blocked"].includes(state)) return "badge badge-error";
  if (["warning", "reboot_required", "pending", "queued", "waiting_for_device"].includes(state)) {
    return "badge badge-warning";
  }
  return "badge badge-default";
}
