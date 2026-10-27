import { NextRequest, NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/auth/authorization";
import { loadSessionAuthorized } from "@/lib/terminal/session-access";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const { admin, service } = await loadSessionAuthorized(id);

    const { data, error } = await service.rpc("terminal_close_session", {
      p_session_id: id,
      p_actor: admin.userId,
      p_reason: (body.reason ?? "Disconnected by administrator").slice(0, 500),
      p_device_id: null,
    });

    if (error) {
      return NextResponse.json({ error: "Failed to close session" }, { status: 500 });
    }

    return NextResponse.json({ success: true, result: data });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
