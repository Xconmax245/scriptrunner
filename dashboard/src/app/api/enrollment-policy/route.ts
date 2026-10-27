import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { httpErrorResponse, requireAdmin } from "@/lib/auth/authorization";

const schema = z.object({
  organization_id: z.string().uuid(),
  auto_authorize_devices: z.boolean().optional(),
  terminal_inactivity_secs: z.number().int().min(60).max(86400).optional(),
  terminal_max_secs: z.number().int().min(60).max(86400).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 422 });
    }

    const admin = await requireAdmin(parsed.data.organization_id);
    const service = createServiceClient();

    const updates: Record<string, unknown> = {};
    if (parsed.data.auto_authorize_devices !== undefined) {
      updates.auto_authorize_devices = parsed.data.auto_authorize_devices;
    }
    if (parsed.data.terminal_inactivity_secs !== undefined) {
      updates.terminal_inactivity_secs = parsed.data.terminal_inactivity_secs;
    }
    if (parsed.data.terminal_max_secs !== undefined) {
      updates.terminal_max_secs = parsed.data.terminal_max_secs;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 422 });
    }

    const { error } = await service
      .from("organization_settings")
      .update(updates)
      .eq("organization_id", admin.organizationId);

    if (error) {
      return NextResponse.json({ error: "Failed to update policy" }, { status: 500 });
    }

    await service.from("audit_events").insert({
      organization_id: admin.organizationId,
      actor_type: "user",
      actor_id: admin.userId,
      action: "organization.enrollment_policy_updated",
      target_type: "organization_settings",
      target_id: admin.organizationId,
      metadata: updates,
    });

    return NextResponse.json({ success: true, policy: updates });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
