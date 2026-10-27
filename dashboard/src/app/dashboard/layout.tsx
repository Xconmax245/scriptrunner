import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { AOSProvider } from "@/components/layout/AOSProvider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  let user: { id: string; email?: string } | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    // Ignore auth error
  }

  let memberships: any[] = [];
  if (user) {
    try {
      const { data } = await supabase
        .from("organization_members")
        .select("organization_id, role, organizations(id, name, slug)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      memberships = data ?? [];
    } catch {
      // Ignore query error
    }
  }

  let organizations =
    memberships
      ?.map((m: any) => {
        const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
        if (!org) return null;
        return {
          id: org.id as string,
          name: org.name as string,
          slug: org.slug as string,
          role: m.role || "owner",
        };
      })
      .filter((o: any): o is { id: string; name: string; slug: string; role: any } => Boolean(o)) ?? [];

  if (!user) {
    const devUserId = process.env.NEXT_PUBLIC_ADMIN_USER_ID || "fc09f0ab-04a7-4b2f-a323-3630736a176a";
    user = { id: devUserId, email: "admin@scriptrunner.local" };
  }

  if (organizations.length === 0) {
    const defaultOrgId = process.env.NEXT_PUBLIC_DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";
    organizations = [
      {
        id: defaultOrgId,
        name: "Acme Corp (Dev)",
        slug: "acme-dev",
        role: "owner",
      },
    ];
  }

  const userEmail = user.email || "admin@scriptrunner.local";

  return (
    <AOSProvider>
      <div
        style={{
          display: "flex",
          height: "100vh",
          overflow: "hidden",
          background: "var(--bg-base)",
        }}
      >
        <Sidebar organizations={organizations} userEmail={userEmail} />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <TopBar />
          <main
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "28px 32px",
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </AOSProvider>
  );
}
