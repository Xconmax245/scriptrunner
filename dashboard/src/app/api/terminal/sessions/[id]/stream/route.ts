/**
 * GET /api/terminal/sessions/[id]/stream
 *
 * Server-Sent Events stream of terminal output, session status and command
 * results. Supports reconnects: the browser sends `Last-Event-ID` (the last
 * output sequence it saw) or `?after=<sequence>`, and the server resumes from
 * that cursor without duplicating output.
 *
 * The browser never talks to the agent and never holds a service-role key.
 */
import { NextRequest } from "next/server";
import { httpErrorResponse } from "@/lib/auth/authorization";
import { isSessionOpen, loadSessionAuthorized } from "@/lib/terminal/session-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 300;
const HEARTBEAT_MS = 15_000;
const MAX_CHUNKS_PER_TICK = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { session, service } = await loadSessionAuthorized(id);

    const url = new URL(req.url);
    const queryCursor = Number(url.searchParams.get("after") ?? 0);
    const headerCursor = Number(req.headers.get("last-event-id") ?? 0);
    let cursor = Math.max(
      Number.isFinite(queryCursor) ? queryCursor : 0,
      Number.isFinite(headerCursor) ? headerCursor : 0
    );

    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener("abort", onAbort);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastCommandsSignature = "";
        let lastStatus = "";
        let lastHeartbeat = Date.now();

        const send = (event: string, data: unknown, id?: number) => {
          if (abortController.signal.aborted) return;
          const frame =
            (id !== undefined ? `id: ${id}\n` : "") +
            `event: ${event}\n` +
            `data: ${JSON.stringify(data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            abortController.abort();
          }
        };

        const { data: device } = await service
          .from("devices")
          .select("id, display_name, hostname, enrollment_status")
          .eq("id", session.device_id)
          .maybeSingle();

        send("ready", {
          session: {
            id: session.id,
            status: session.status,
            hostname: session.hostname_snapshot ?? device?.hostname ?? null,
            device_id: session.device_id,
            device_name: device?.display_name ?? null,
            created_at: session.created_at,
            expires_at: session.expires_at,
          },
          cursor,
        });

        try {
          while (!abortController.signal.aborted) {
            const { data: chunks, error: chunkError } = await service
              .from("terminal_output")
              .select("sequence, stream, content, created_at")
              .eq("session_id", id)
              .gt("sequence", cursor)
              .order("sequence", { ascending: true })
              .limit(MAX_CHUNKS_PER_TICK);

            if (chunkError) {
              send("error", { message: "Failed to read terminal output" });
              break;
            }

            if (chunks && chunks.length > 0) {
              cursor = Number(chunks[chunks.length - 1].sequence);
              send("output", { items: chunks }, cursor);
            }

            const { data: current } = await service
              .from("terminal_sessions")
              .select("status, close_reason, last_activity_at, last_command_sequence, expires_at")
              .eq("id", id)
              .single();

            const statusSignature = `${current?.status}|${current?.close_reason}`;
            if (statusSignature !== lastStatus) {
              lastStatus = statusSignature;
              send("status", {
                status: current?.status ?? "closed",
                close_reason: current?.close_reason ?? null,
                last_activity_at: current?.last_activity_at ?? null,
                last_command_sequence: current?.last_command_sequence ?? 0,
                expires_at: current?.expires_at ?? null,
              });
            }

            const { data: commands } = await service
              .from("terminal_commands")
              .select("sequence, delivered_at, completed_at, exit_ok, error_summary")
              .eq("session_id", id)
              .order("sequence", { ascending: false })
              .limit(20);

            const commandList = (commands ?? []).slice().reverse();
            const commandSignature = JSON.stringify(commandList);
            if (commandSignature !== lastCommandsSignature) {
              lastCommandsSignature = commandSignature;
              send("commands", { items: commandList });
            }

            if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
              lastHeartbeat = Date.now();
              if (!abortController.signal.aborted) {
                try {
                  controller.enqueue(encoder.encode(`: keepalive\n\n`));
                } catch {
                  abortController.abort();
                }
              }
            }

            if (current && !isSessionOpen(current.status)) {
              // Give the client one final drain tick of output, then finish.
              const { data: tail } = await service
                .from("terminal_output")
                .select("sequence, stream, content, created_at")
                .eq("session_id", id)
                .gt("sequence", cursor)
                .order("sequence", { ascending: true })
                .limit(MAX_CHUNKS_PER_TICK);

              if (tail && tail.length > 0) {
                cursor = Number(tail[tail.length - 1].sequence);
                send("output", { items: tail }, cursor);
              }

              send("end", {
                status: current.status,
                close_reason: current.close_reason ?? null,
              });
              break;
            }

            await sleep(TICK_MS);
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            send("error", {
              message: error instanceof Error ? error.message : "Stream error",
            });
          }
        } finally {
          req.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        abortController.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
