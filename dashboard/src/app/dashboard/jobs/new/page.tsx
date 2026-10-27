import { createServiceClient } from "@/lib/supabase/server";
import { NewJobForm } from "@/components/jobs/NewJobForm";
import { PageTransition } from "@/components/layout/PageTransition";

export const metadata = { title: "New Job" };

export default async function NewJobPage() {
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
    isOnline:
      !!d.last_seen_at &&
      now - new Date(d.last_seen_at).getTime() < onlineThresholdMs,
  }));

  let settings: any = null;
  try {
    const { data } = await supabase
      .from("organization_settings")
      .select("default_timeout_secs, default_expiry_secs, max_script_bytes")
      .eq("organization_id", orgId)
      .single();
    settings = data;
  } catch {}

  return (
    <PageTransition>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Dispatch PowerShell Job
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            Craft and run remote commands securely on enrolled target endpoints.
          </p>
        </div>
        <NewJobForm
          devices={devicesWithStatus}
          organizationId={orgId}
          defaultTimeout={settings?.default_timeout_secs ?? 300}
          defaultExpirySeconds={settings?.default_expiry_secs ?? 86400}
          maxScriptBytes={settings?.max_script_bytes ?? 131072}
        />
      </div>
    </PageTransition>
  );
}
