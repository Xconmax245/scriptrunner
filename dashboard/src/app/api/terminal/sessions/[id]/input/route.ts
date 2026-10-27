import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { httpErrorResponse } from "@/lib/auth/authorization";
import { loadSessionAuthorized } from "@/lib/terminal/session-access";

const schema = z.object({
  command: z.string().min(1).max(16384),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid command" }, { status: 422 });
    }

    const { admin, service } = await loadSessionAuthorized(id);

    const { data, error } = await service.rpc("terminal_post_command", {
      p_session_id: id,
      p_actor: admin.userId,
      p_command: parsed.data.command,
    });

    if (error) {
      console.error("terminal_post_command failed:", error.message);
      return NextResponse.json({ error: "Failed to queue command" }, { status: 500 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row?.result !== "ok") {
      const map: Record<string, { status: number; message: string }> = {
        not_found: { status: 404, message: "Session not found" },
        forbidden: { status: 403, message: "Not authorized for this session" },
        session_closed: { status: 409, message: "Session is closed" },
        session_expired: { status: 409, message: "Session has expired" },
        invalid_command: { status: 422, message: "Invalid command" },
      };
      const entry = map[row?.result as string] ?? {
        status: 500,
        message: "Failed to queue command",
      };
      return NextResponse.json({ error: entry.message }, { status: entry.status });
    }

    return NextResponse.json({
      success: true,
      sequence: Number(row.command_sequence),
    });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
