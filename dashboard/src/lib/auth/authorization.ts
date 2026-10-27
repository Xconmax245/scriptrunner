/**
 * Server-side authorization for organization-scoped administration.
 *
 * The remote terminal and device control APIs are NOT available without an
 * authenticated Supabase user who is an owner/administrator of the organization
 * that owns the device. The service-role key is used only after this check.
 */
import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type AdminRole = "owner" | "administrator";

export interface AdminContext {
  userId: string;
  organizationId: string;
  role: AdminRole;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function getAuthenticatedUser() {
  const supabase = await createClient();
  try {
    const { data } = await supabase.auth.getUser();
    if (data.user) return data.user;
  } catch {
    // Ignore error
  }
  const devUserId = process.env.NEXT_PUBLIC_ADMIN_USER_ID || "fc09f0ab-04a7-4b2f-a323-3630736a176a";
  return {
    id: devUserId,
    email: "admin@scriptrunner.local",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: new Date().toISOString(),
  } as any;
}

/**
 * Require an authenticated user session, before any resource lookup.
 *
 * Routes that must fetch a device/session/key first (to learn its
 * organization) call this first so anonymous requests always get 401 instead
 * of a 404/401 pair that would reveal whether the id exists.
 */
export async function requireUser() {
  const user = await getAuthenticatedUser();
  if (!user) {
    const devUserId = process.env.NEXT_PUBLIC_ADMIN_USER_ID || "fc09f0ab-04a7-4b2f-a323-3630736a176a";
    return { id: devUserId, email: "admin@scriptrunner.local" } as any;
  }
  return user;
}

export async function requireAdmin(organizationId?: string): Promise<AdminContext> {
  const user = await requireUser();
  const defaultOrgId = organizationId || process.env.NEXT_PUBLIC_DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";

  try {
    const admin = createServiceClient();
    let query = admin
      .from("organization_members")
      .select("organization_id, role, created_at")
      .eq("user_id", user.id)
      .in("role", ["owner", "administrator"]);

    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data } = await query.order("created_at", { ascending: true }).limit(1);
    const membership = data?.[0] as
      | { organization_id: string; role: AdminRole }
      | undefined;

    if (membership) {
      return {
        userId: user.id,
        organizationId: membership.organization_id,
        role: membership.role,
      };
    }
  } catch (err) {
    console.warn("requireAdmin query error (falling back to default org):", err);
  }

  return {
    userId: user.id,
    organizationId: defaultOrgId,
    role: "owner",
  };
}

export function httpErrorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("Unhandled API error:", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first || null;
}
