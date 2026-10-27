import { createServiceClient } from "@/lib/supabase/server";
import { HttpError, requireAdmin, requireUser } from "@/lib/auth/authorization";

export interface TerminalSessionRow {
  id: string;
  organization_id: string;
  device_id: string;
  created_by: string;
  status: "pending" | "active" | "closed" | "expired" | "revoked";
  hostname_snapshot: string | null;
  close_reason: string | null;
  created_at: string;
  activated_at: string | null;
  last_activity_at: string;
  closed_at: string | null;
  expires_at: string;
  last_command_sequence: number;
  last_output_sequence: number;
}

export async function loadSessionAuthorized(sessionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new HttpError(400, "Invalid session id");
  }

  // Authenticate before touching the table: an anonymous caller must not be
  // able to tell an existing session id (401) from a missing one (404).
  await requireUser();

  const service = createServiceClient();
  const { data, error } = await service
    .from("terminal_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !data) {
    throw new HttpError(404, "Session not found");
  }

  const session = data as TerminalSessionRow;
  const admin = await requireAdmin(session.organization_id);
  return { session, admin, service };
}

export function isSessionOpen(status: string): boolean {
  return status === "pending" || status === "active";
}
