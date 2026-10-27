import { createServiceClient } from "@/lib/supabase/server";
import { adminPageContext } from "@/lib/rmm/page-auth";
import { createGroupAction, updateGroupMembershipAction } from "@/lib/rmm/actions";
import { Notice } from "@/components/rmm/Notice";
import { PageTransition } from "@/components/layout/PageTransition";
import { FolderTree, Plus } from "lucide-react";

export const metadata = { title: "Device groups" };
export const dynamic = "force-dynamic";

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const admin = await adminPageContext("/dashboard/groups");
  const supabase = createServiceClient();

  const [{ data: groups }, { data: devices }, { data: members }] = await Promise.all([
    supabase.from("device_groups").select("*").eq("organization_id", admin.organizationId).order("name"),
    supabase
      .from("devices")
      .select("id, hostname, display_name, enrollment_status")
      .eq("organization_id", admin.organizationId)
      .order("display_name"),
    supabase
      .from("device_group_members")
      .select("group_id, device_id, added_at"),
  ]);

  const dynamicCounts = new Map<string, string[]>();
  for (const group of groups ?? []) {
    if (group.group_type === "dynamic") {
      const { data } = await supabase.rpc("rmm_group_device_ids", { p_group_id: group.id });
      dynamicCounts.set(
        group.id,
        (data ?? [])
          .map((row: any) => (typeof row === "string" ? row : row?.rmm_group_device_ids ?? row?.id))
          .filter((value: unknown): value is string => typeof value === "string")
      );
    }
  }

  const orgDeviceIds = new Set((devices ?? []).map((d: any) => d.id));
  const memberships = (members ?? []).filter((m: any) => orgDeviceIds.has(m.device_id));

  return (
    <PageTransition>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Device groups</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            Static groups hold explicit members. Dynamic groups evaluate rules against inventory each time they are used.
          </p>
        </div>

        <Notice error={error} />

        <div className="card" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <Plus style={{ width: 15, height: 15 }} />
            <h2 style={{ fontSize: 13, fontWeight: 600 }}>Create group</h2>
          </div>
          <form action={createGroupAction} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              <div>
                <label className="label" htmlFor="group-name">Name</label>
                <input id="group-name" name="name" className="input" required maxLength={120} />
              </div>
              <div>
                <label className="label" htmlFor="group-type">Type</label>
                <select id="group-type" name="group_type" className="input" defaultValue="static">
                  <option value="static">Static (explicit members)</option>
                  <option value="dynamic">Dynamic (rule-based)</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="group-description">Description</label>
                <input id="group-description" name="description" className="input" maxLength={500} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="group-rules">Dynamic rules (JSON, ignored for static groups)</label>
              <textarea
                id="group-rules"
                name="dynamic_rules"
                className="input"
                rows={3}
                defaultValue={'{"match":"all","rules":[{"field":"os","op":"contains","value":"Windows 11"}]}'}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              />
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                Supported fields: hostname, os, os_version, os_build, manufacturer, model, agent_version, tag.
              </p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary btn-sm" type="submit">Create group</button>
            </div>
          </form>
        </div>

        {(groups ?? []).length === 0 ? (
          <div className="card" style={{ padding: 36, textAlign: "center", color: "var(--text-tertiary)" }}>
            <FolderTree style={{ width: 22, height: 22, margin: "0 auto 8px" }} />
            No groups defined yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(groups ?? []).map((group: any) => {
              const staticMembers = memberships.filter((m: any) => m.group_id === group.id);
              const dynamicMembers = dynamicCounts.get(group.id) ?? [];
              const memberIds = group.group_type === "dynamic"
                ? dynamicMembers
                : staticMembers.map((m: any) => m.device_id);
              return (
                <div key={group.id} className="card" style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <h2 style={{ fontSize: 13.5, fontWeight: 600 }}>{group.name}</h2>
                        <span className="badge badge-default">{group.group_type}</span>
                        <span className="badge badge-default">{memberIds.length} device(s)</span>
                      </div>
                      {group.description && (
                        <p style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 3 }}>{group.description}</p>
                      )}
                      {group.group_type === "dynamic" && (
                        <pre className="code-block" style={{ marginTop: 8, fontSize: 11 }}>
                          {JSON.stringify(group.dynamic_rules, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>

                  {group.group_type === "static" && (
                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                      <form action={updateGroupMembershipAction} style={{ display: "flex", gap: 8 }}>
                        <input type="hidden" name="group_id" value={group.id} />
                        <select name="device_id" className="input" required style={{ flex: 1 }}>
                          <option value="">Add a device…</option>
                          {(devices ?? [])
                            .filter((d: any) => !staticMembers.some((m: any) => m.device_id === d.id))
                            .map((d: any) => (
                              <option key={d.id} value={d.id}>{d.hostname ?? d.display_name}</option>
                            ))}
                        </select>
                        <button className="btn btn-secondary btn-sm" type="submit">Add</button>
                      </form>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {staticMembers.length === 0 && (
                          <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>No explicit members.</span>
                        )}
                        {staticMembers.map((member: any) => {
                          const device = (devices ?? []).find((d: any) => d.id === member.device_id);
                          return (
                            <form key={member.device_id} action={updateGroupMembershipAction}>
                              <input type="hidden" name="group_id" value={group.id} />
                              <input type="hidden" name="device_id" value={member.device_id} />
                              <input type="hidden" name="remove" value="true" />
                              <button className="badge badge-default" type="submit" title="Remove from group">
                                {device?.hostname ?? device?.display_name ?? member.device_id.slice(0, 8)} ×
                              </button>
                            </form>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {group.group_type === "dynamic" && memberIds.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                      {memberIds.map((deviceId: string) => {
                        const device = (devices ?? []).find((d: any) => d.id === deviceId);
                        return (
                          <span key={deviceId} className="badge badge-default">
                            {device?.hostname ?? device?.display_name ?? deviceId.slice(0, 8)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageTransition>
  );
}
