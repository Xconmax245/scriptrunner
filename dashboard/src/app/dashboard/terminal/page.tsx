import { createServiceClient } from "@/lib/supabase/server";
import { WorkingTerminal } from "@/components/terminal/WorkingTerminal";
import { PageTransition } from "@/components/layout/PageTransition";

export const metadata = { title: "Remote Terminal" };
export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  const supabase = createServiceClient();

  let orgId = process.env.DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000001";
  try {
    const { data: orgs } = await supabase
      .from("organizations")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1);
    if (orgs && orgs.length > 0) orgId = orgs[0].id;
  } catch {}

  let devices: any[] = [];
  try {
    const { data } = await supabase
      .from("devices")
      .select("id, display_name, hostname, operating_system, last_seen_at, enrollment_status")
      .eq("organization_id", orgId)
      .eq("enrollment_status", "enrolled")
      .order("display_name", { ascending: true });
    devices = data ?? [];
  } catch {}

  const now = Date.now();
  const onlineThresholdMs = 5 * 60 * 1000;
  const devicesWithStatus = devices.map((d: any) => ({
    ...d,
    isOnline: !!d.last_seen_at && now - new Date(d.last_seen_at).getTime() < onlineThresholdMs,
  }));

  return (
    <PageTransition>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Live Remote Terminal
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            Interactive PowerShell console with instant command execution, live output, and audit logging.
          </p>
        </div>

        <WorkingTerminal devices={devicesWithStatus} />
      </div>
    </PageTransition>
  );
}
