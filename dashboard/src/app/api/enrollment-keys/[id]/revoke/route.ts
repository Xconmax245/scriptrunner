import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { httpErrorResponse, requireAdmin, requireUser } from "@/lib/auth/authorization";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Authenticate before the key lookup (no existence oracle for
    // unauthenticated callers).
    await requireUser();

    const service = createServiceClient();

    const { data: key } = await service
      .from("organization_enrollment_keys")
      .select("id, organization_id, revoked_at")
      .eq("id", id)
      .maybeSingle();

    if (!key) {
      return NextResponse.json({ error: "Enrollment key not found" }, { status: 404 });
    }

    const admin = await requireAdmin(key.organization_id);

    if (key.revoked_at) {
      return NextResponse.json({ success: true, already_revoked: true });
    }

    const { error } = await service
      .from("organization_enrollment_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      return NextResponse.json({ error: "Failed to revoke enrollment key" }, { status: 500 });
    }

    await service.from("audit_events").insert({
      organization_id: key.organization_id,
      actor_type: "user",
      actor_id: admin.userId,
      action: "enrollment_key.revoked",
      target_type: "enrollment_key",
      target_id: id,
      metadata: {},
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
