import { NextRequest, NextResponse } from "next/server";
import { storePackageFile, createDeployments, DetectionRule } from "@/lib/rmm/deploymentStore";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    const adminUserId = user?.id || process.env.NEXT_PUBLIC_ADMIN_USER_ID || "fc09f0ab-04a7-4b2f-a323-3630736a176a";
    const organizationId = process.env.DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const deviceIdsRaw = formData.get("device_ids");
    const customName = (formData.get("name") as string | null) || undefined;
    const customVersion = (formData.get("version") as string | null) || undefined;
    const installArgs = (formData.get("install_args") as string | null) || undefined;
    const rebootPolicy = (formData.get("reboot_policy") as string | null) || "never";
    const timeoutSeconds = Number(formData.get("timeout_seconds")) || 600;
    const detectionRuleRaw = formData.get("detection_rule") as string | null;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: "Please select an installer file." }, { status: 400 });
    }

    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (![".msi", ".exe", ".msix", ".zip"].includes(ext)) {
      return NextResponse.json(
        { error: "Unsupported installer format. Only .msi and .exe (or .msix, .zip) are supported." },
        { status: 400 }
      );
    }

    let deviceIds: string[] = [];
    if (typeof deviceIdsRaw === "string") {
      try {
        const parsed = JSON.parse(deviceIdsRaw);
        if (Array.isArray(parsed)) {
          deviceIds = parsed.filter((id) => typeof id === "string" && id.trim().length > 0);
        }
      } catch {
        deviceIds = deviceIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }

    const supabase = createServiceClient();

    // If "all_online" or empty, select enrolled devices
    const { data: devices } = await supabase
      .from("devices")
      .select("id, hostname, display_name, last_seen_at")
      .eq("organization_id", organizationId)
      .eq("enrollment_status", "enrolled");

    const allDevices = devices || [];

    if (deviceIds.includes("all_online") || deviceIds.length === 0) {
      const now = Date.now();
      const online = allDevices.filter(
        (d) => d.last_seen_at && now - new Date(d.last_seen_at).getTime() < 3 * 60 * 1000
      );
      if (online.length > 0) {
        deviceIds = online.map((d) => d.id);
      } else if (allDevices.length > 0) {
        deviceIds = [allDevices[0].id];
      }
    }

    if (deviceIds.length === 0) {
      return NextResponse.json(
        { error: "No target devices selected or available for deployment." },
        { status: 400 }
      );
    }

    let parsedDetectionRule: DetectionRule | undefined;
    if (detectionRuleRaw) {
      try {
        parsedDetectionRule = JSON.parse(detectionRuleRaw);
      } catch {}
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. Store package binary and extract metadata
    const storedPkg = await storePackageFile(buffer, file.name, {
      name: customName,
      version: customVersion,
      installArgs,
      detectionRule: parsedDetectionRule,
      requiresReboot: rebootPolicy === "if_required" || rebootPolicy === "always",
      timeoutSeconds,
    });

    // 2. Resolve target device hostnames
    const targetMap = new Map(allDevices.map((d) => [d.id, d.hostname || d.display_name || "Windows Host"]));
    const targets = deviceIds.map((id) => ({
      deviceId: id,
      hostname: targetMap.get(id) || "Windows Host",
    }));

    // 3. Create deployment jobs in store
    const createdJobs = await createDeployments(storedPkg, targets, organizationId, adminUserId);

    // 4. Audit event
    try {
      await supabase.from("audit_events").insert({
        organization_id: organizationId,
        actor_type: "user",
        actor_id: adminUserId,
        action: "software.deployed",
        target_type: "software_package",
        target_id: storedPkg.packageId,
        metadata: {
          package_name: storedPkg.packageName,
          version: storedPkg.version,
          format: storedPkg.packageFormat,
          file_name: file.name,
          file_size_bytes: file.size,
          sha256: storedPkg.sha256,
          target_count: targets.length,
          target_device_ids: deviceIds,
        },
      });
    } catch {}

    return NextResponse.json({
      success: true,
      message: `Deployment initiated for ${storedPkg.packageName} (${storedPkg.version}) to ${createdJobs.length} device(s).`,
      package: storedPkg,
      jobs: createdJobs,
    });
  } catch (error: any) {
    console.error("Direct software deployment failed:", error);
    return NextResponse.json(
      { error: error.message || "Failed to initiate software deployment." },
      { status: 500 }
    );
  }
}
