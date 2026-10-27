"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, clientIp } from "@/lib/auth/authorization";

const PACKAGE_BUCKET = process.env.PACKAGE_BUCKET ?? "software-packages";
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

const uuidRegex =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MONITOR_KINDS = [
  "cpu", "memory", "disk", "process", "service", "event_log", "file",
  "directory", "registry", "powershell", "ping", "tcp", "hardware", "os",
  "custom_metric",
] as const;

function text(form: FormData, key: string, max = 500): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(form: FormData, key: string, max = 500): string | null {
  const value = text(form, key, max);
  return value.length > 0 ? value : null;
}

function integer(form: FormData, key: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(text(form, key, 20), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function uuid(value: string): string | null {
  return uuidRegex.test(value) ? value : null;
}

function jsonObject(value: string, label: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(label + " must be a JSON object");
    }
    if (JSON.stringify(parsed).length > 16 * 1024) {
      throw new Error(label + " is too large");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      label + " is not valid JSON: " + (error instanceof Error ? error.message : "parse error")
    );
  }
}

function jsonArray(value: string, label: string): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error(label + " must be a JSON array");
    if (JSON.stringify(parsed).length > 16 * 1024) throw new Error(label + " is too large");
    return parsed;
  } catch (error) {
    throw new Error(
      label + " is not valid JSON: " + (error instanceof Error ? error.message : "parse error")
    );
  }
}

function back(path: string, error?: string): never {
  if (error) {
    redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`);
  }
  redirect(path);
}

async function audit(
  organizationId: string,
  userId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {}
) {
  const supabase = createServiceClient();
  await supabase.from("audit_events").insert({
    organization_id: organizationId,
    actor_type: "user",
    actor_id: userId,
    action,
    target_type: targetType,
    target_id: targetId,
    metadata,
  });
}

// ---------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------

export async function createMonitorAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();
    const name = text(form, "name", 160);
    const kind = text(form, "kind", 40);
    if (!name || !MONITOR_KINDS.includes(kind as (typeof MONITOR_KINDS)[number])) {
      back("/dashboard/monitoring", "A monitor name and valid kind are required.");
    }

    const scope = text(form, "scope", 20);
    const deviceId = scope === "device" ? uuid(text(form, "device_id", 40)) : null;
    const groupId = scope === "group" ? uuid(text(form, "group_id", 40)) : null;
    if (scope === "device" && !deviceId) back("/dashboard/monitoring", "Select a device.");
    if (scope === "group" && !groupId) back("/dashboard/monitoring", "Select a device group.");

    if (deviceId) {
      const { data: device } = await supabase
        .from("devices")
        .select("organization_id")
        .eq("id", deviceId)
        .maybeSingle();
      if (!device || device.organization_id !== admin.organizationId) {
        back("/dashboard/monitoring", "Device is not in your organization.");
      }
    }
    if (groupId) {
      const { data: group } = await supabase
        .from("device_groups")
        .select("organization_id")
        .eq("id", groupId)
        .maybeSingle();
      if (!group || group.organization_id !== admin.organizationId) {
        back("/dashboard/monitoring", "Device group is not in your organization.");
      }
    }

    const config = jsonObject(text(form, "config", 16384), "Monitor config");
    const insert = {
      organization_id: admin.organizationId,
      name,
      kind,
      device_id: deviceId,
      group_id: groupId,
      config,
      interval_seconds: integer(form, "interval_seconds", 15, 86400, 60),
      timeout_seconds: integer(form, "timeout_seconds", 1, 600, 30),
      severity: ["info", "warning", "critical"].includes(text(form, "severity", 20))
        ? text(form, "severity", 20)
        : "warning",
      breach_samples: integer(form, "breach_samples", 1, 60, 1),
      recovery_samples: integer(form, "recovery_samples", 1, 60, 1),
      auto_recovery: text(form, "auto_recovery", 10) === "on",
      recovery_action: jsonObject(text(form, "recovery_action", 4096), "Recovery action"),
      created_by: admin.userId,
      updated_by: admin.userId,
    };

    const { data, error } = await supabase.from("monitors").insert(insert).select("id").single();
    if (error) back("/dashboard/monitoring", error.message);

    await audit(admin.organizationId, admin.userId, "monitor.created", "monitor", data?.id ?? null, {
      kind, scope,
    });
    revalidatePath("/dashboard/monitoring");
    back("/dashboard/monitoring");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/monitoring", error instanceof Error ? error.message : "Failed to create monitor.");
  }
}

export async function updateMonitorAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const id = uuid(text(form, "monitor_id", 40));
    if (!id) back("/dashboard/monitoring", "Invalid monitor.");

    const supabase = createServiceClient();
    const { data: monitor } = await supabase
      .from("monitors")
      .select("id, organization_id")
      .eq("id", id)
      .maybeSingle();
    if (!monitor || monitor.organization_id !== admin.organizationId) {
      back("/dashboard/monitoring", "Monitor not found.");
    }

    const enabled = text(form, "enabled", 10) === "on";
    const severity = text(form, "severity", 20);
    const interval = integer(form, "interval_seconds", 15, 86400, 60);
    const breach = integer(form, "breach_samples", 1, 60, 1);

    const { error } = await supabase
      .from("monitors")
      .update({
        enabled,
        severity: ["info", "warning", "critical"].includes(severity) ? severity : "warning",
        interval_seconds: interval,
        breach_samples: breach,
        updated_by: admin.userId,
      })
      .eq("id", id);
    if (error) back("/dashboard/monitoring", error.message);

    await audit(admin.organizationId, admin.userId, "monitor.updated", "monitor", id, {
      enabled, severity, interval_seconds: interval, breach_samples: breach,
    });
    revalidatePath("/dashboard/monitoring");
    back("/dashboard/monitoring");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/monitoring", error instanceof Error ? error.message : "Failed to update monitor.");
  }
}

export async function deleteMonitorAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const id = uuid(text(form, "monitor_id", 40));
    if (!id) back("/dashboard/monitoring", "Invalid monitor.");

    const supabase = createServiceClient();
    const { data: monitor } = await supabase
      .from("monitors")
      .select("id, organization_id, name")
      .eq("id", id)
      .maybeSingle();
    if (!monitor || monitor.organization_id !== admin.organizationId) {
      back("/dashboard/monitoring", "Monitor not found.");
    }

    const { error } = await supabase.from("monitors").delete().eq("id", id);
    if (error) back("/dashboard/monitoring", error.message);

    await audit(admin.organizationId, admin.userId, "monitor.deleted", "monitor", id, {
      name: monitor.name,
    });
    revalidatePath("/dashboard/monitoring");
    back("/dashboard/monitoring");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/monitoring", error instanceof Error ? error.message : "Failed to delete monitor.");
  }
}

// ---------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------

export async function acknowledgeAlertAction(form: FormData): Promise<void> {
  const id = uuid(text(form, "alert_id", 40));
  try {
    const admin = await requireAdmin();
    if (!id) back("/dashboard/alerts", "Invalid alert.");
    const supabase = createServiceClient();
    const { error } = await supabase.rpc("rmm_acknowledge_alert", {
      p_alert_id: id,
      p_actor_user_id: admin.userId,
      p_org_id: admin.organizationId,
      p_note: optionalText(form, "note", 500),
    });
    if (error) back("/dashboard/alerts", error.message);
    revalidatePath("/dashboard/alerts");
    back("/dashboard/alerts");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/alerts", error instanceof Error ? error.message : "Failed to acknowledge alert.");
  }
}

export async function resolveAlertAction(form: FormData): Promise<void> {
  const id = uuid(text(form, "alert_id", 40));
  try {
    const admin = await requireAdmin();
    if (!id) back("/dashboard/alerts", "Invalid alert.");
    const supabase = createServiceClient();
    const { error } = await supabase.rpc("rmm_resolve_alert", {
      p_alert_id: id,
      p_actor_user_id: admin.userId,
      p_org_id: admin.organizationId,
      p_note: optionalText(form, "note", 500),
    });
    if (error) back("/dashboard/alerts", error.message);
    revalidatePath("/dashboard/alerts");
    back("/dashboard/alerts");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/alerts", error instanceof Error ? error.message : "Failed to resolve alert.");
  }
}

// ---------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------

export async function publishPackageAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();

    const name = text(form, "name", 160);
    const version = text(form, "version", 60);
    const format = text(form, "package_format", 10);
    if (!name || !version || !["msi", "exe"].includes(format)) {
      back("/dashboard/software", "Package name, version and format are required.");
    }

    const file = form.get("package_file");
    if (!(file instanceof File) || file.size === 0) {
      back("/dashboard/software", "Select a package file to upload.");
    }
    if (file.size > MAX_PACKAGE_BYTES) {
      back("/dashboard/software", "Package exceeds the 512 MB upload limit.");
    }

    const expectedExtension = format === "msi" ? ".msi" : ".exe";
    if (!file.name.toLowerCase().endsWith(expectedExtension)) {
      back("/dashboard/software", `A ${format.toUpperCase()} package must use a ${expectedExtension} file.`);
    }

    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const buffer = Buffer.from(await file.arrayBuffer());
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    const { data: packageRow, error: packageErr } = await supabase
      .from("software_packages")
      .upsert(
        {
          organization_id: admin.organizationId,
          name,
          description: optionalText(form, "description", 2000),
          publisher: optionalText(form, "publisher", 160),
          is_internal: text(form, "is_internal", 10) === "on",
          created_by: admin.userId,
        },
        { onConflict: "organization_id,name" }
      )
      .select("id")
      .single();
    if (packageErr || !packageRow) back("/dashboard/software", packageErr?.message ?? "Package creation failed.");

    const storagePath = `${admin.organizationId}/${packageRow.id}/${version}/${safeName}`;
    const { error: uploadErr } = await supabase.storage
      .from(PACKAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: "application/octet-stream",
        upsert: false,
      });
    if (uploadErr) {
      back("/dashboard/software", "Package upload failed: " + uploadErr.message);
    }

    const requiresReboot = text(form, "requires_reboot", 10) === "on";

    // A known previous approved version is the only rollback path that can be
    // advertised. Arbitrary installers are never assumed to be reversible.
    const { data: previousVersions } = await supabase
      .from("software_package_versions")
      .select("id, version, approved_at, created_at")
      .eq("package_id", packageRow.id)
      .eq("approval_status", "approved")
      .order("created_at", { ascending: false })
      .limit(1);
    const rollbackVersionId = previousVersions?.[0]?.id ?? null;

    const { data: versionRow, error: versionErr } = await supabase
      .from("software_package_versions")
      .insert({
        package_id: packageRow.id,
        organization_id: admin.organizationId,
        version,
        package_format: format,
        architecture: text(form, "architecture", 10) || "x64",
        supported_os: optionalText(form, "supported_os", 300),
        storage_path: storagePath,
        sha256,
        file_size_bytes: file.size,
        signature_subject: optionalText(form, "signature_subject", 500),
        install_args: optionalText(form, "install_args", 2000),
        uninstall_args: optionalText(form, "uninstall_args", 2000),
        repair_args: optionalText(form, "repair_args", 2000),
        detection_rules: jsonObject(text(form, "detection_rules", 8192), "Detection rules"),
        prerequisites: jsonArray(text(form, "prerequisites", 16384), "Prerequisites"),
        requires_reboot: requiresReboot,
        rollback_version_id: rollbackVersionId,
        approval_status: "pending",
        created_by: admin.userId,
      })
      .select("id")
      .single();
    if (versionErr || !versionRow) {
      back("/dashboard/software", versionErr?.message ?? "Package version creation failed.");
    }

    await audit(admin.organizationId, admin.userId, "package.published", "package_version", versionRow.id, {
      package_id: packageRow.id,
      name,
      version,
      format,
      sha256,
      file_size_bytes: file.size,
    });

    revalidatePath("/dashboard/software");
    back("/dashboard/software");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/software", error instanceof Error ? error.message : "Package upload failed.");
  }
}

export async function approvePackageVersionAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const id = uuid(text(form, "version_id", 40));
    if (!id) back("/dashboard/software", "Invalid package version.");

    const supabase = createServiceClient();
    const { data: versionRow } = await supabase
      .from("software_package_versions")
      .select("id, organization_id, approval_status, package_id, version")
      .eq("id", id)
      .maybeSingle();
    if (!versionRow || versionRow.organization_id !== admin.organizationId) {
      back("/dashboard/software", "Package version not found.");
    }

    const approve = text(form, "approve", 10) !== "false";
    const { error } = await supabase
      .from("software_package_versions")
      .update({
        approval_status: approve ? "approved" : "rejected",
        approved_by: approve ? admin.userId : null,
        approved_at: approve ? new Date().toISOString() : null,
        published_at: approve ? new Date().toISOString() : null,
      })
      .eq("id", id);
    if (error) back("/dashboard/software", error.message);

    await audit(
      admin.organizationId,
      admin.userId,
      approve ? "package.approved" : "package.rejected",
      "package_version",
      id,
      { package_id: versionRow.package_id, version: versionRow.version }
    );

    revalidatePath("/dashboard/software");
    back("/dashboard/software");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/software", error instanceof Error ? error.message : "Failed to update approval.");
  }
}

// ---------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------

export async function createDeploymentAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();

    const versionId = uuid(text(form, "version_id", 40));
    if (!versionId) back("/dashboard/software", "Select a package version.");

    const { data: requestedVersion } = await supabase
      .from("software_package_versions")
      .select("id, organization_id, approval_status, package_id, version, prerequisites, package_format, rollback_version_id")
      .eq("id", versionId)
      .maybeSingle();
    if (!requestedVersion || requestedVersion.organization_id !== admin.organizationId) {
      back("/dashboard/software", "Package version not found.");
    }
    if (requestedVersion.approval_status !== "approved") {
      back("/dashboard/software", "Approve the package version before deploying it.");
    }

    const operation = text(form, "operation", 20) || "install";
    if (!["install", "update", "repair", "uninstall", "rollback"].includes(operation)) {
      back("/dashboard/software", "Unsupported deployment operation.");
    }

    // Rollback targets the recorded previous approved version. Without one, the
    // request is rejected instead of pretending an uninstall/reinstall is a
    // reliable rollback.
    let deployVersionId = versionId;
    if (operation === "rollback") {
      if (!requestedVersion.rollback_version_id) {
        back("/dashboard/software", "Rollback is not available for this package version (no previous approved version recorded).");
      }
      const { data: rollbackVersion } = await supabase
        .from("software_package_versions")
        .select("id, organization_id, approval_status, prerequisites, version, package_format")
        .eq("id", requestedVersion.rollback_version_id)
        .maybeSingle();
      if (!rollbackVersion || rollbackVersion.organization_id !== admin.organizationId
          || rollbackVersion.approval_status !== "approved") {
        back("/dashboard/software", "The recorded rollback version is no longer approved or available.");
      }
      deployVersionId = rollbackVersion.id;
    }

    const { data: versionRow, error: versionLoadErr } = await supabase
      .from("software_package_versions")
      .select("id, organization_id, approval_status, package_id, version, prerequisites, package_format")
      .eq("id", deployVersionId)
      .maybeSingle();
    if (versionLoadErr || !versionRow
        || versionRow.organization_id !== admin.organizationId
        || versionRow.approval_status !== "approved") {
      back("/dashboard/software", "Deployment target version could not be loaded or is not approved.");
    }

    const targetMode = text(form, "target_mode", 20);
    const targetDevice = targetMode === "device" ? uuid(text(form, "target_device_id", 40)) : null;
    const targetGroup = targetMode === "group" ? uuid(text(form, "target_group_id", 40)) : null;
    if (!targetDevice && !targetGroup) {
      back("/dashboard/software", "Select a target device or group.");
    }

    if (targetDevice) {
      const { data: device } = await supabase
        .from("devices")
        .select("organization_id")
        .eq("id", targetDevice)
        .maybeSingle();
      if (!device || device.organization_id !== admin.organizationId) {
        back("/dashboard/software", "Target device is not in your organization.");
      }
    }
    if (targetGroup) {
      const { data: group } = await supabase
        .from("device_groups")
        .select("organization_id")
        .eq("id", targetGroup)
        .maybeSingle();
      if (!group || group.organization_id !== admin.organizationId) {
        back("/dashboard/software", "Target group is not in your organization.");
      }
    }

    const windowDays = text(form, "window_days", 100)
      .split(",")
      .map((d) => Number.parseInt(d.trim(), 10))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    const windowStart = text(form, "window_start", 5);
    const windowEnd = text(form, "window_end", 5);
    const maintenanceWindow =
      windowStart && windowEnd
        ? { days: windowDays, start: windowStart, end: windowEnd }
        : {};

    const { data: policy, error: policyErr } = await supabase
      .from("deployment_policies")
      .insert({
        organization_id: admin.organizationId,
        name: text(form, "name", 160) || `Deploy ${operation}`,
        package_version_id: deployVersionId,
        operation,
        target_type: targetGroup ? "group" : "device",
        target_device_id: targetDevice,
        target_group_id: targetGroup,
        schedule_at: text(form, "schedule_at", 40) || null,
        maintenance_window: maintenanceWindow,
        concurrency_limit: integer(form, "concurrency_limit", 1, 100, 5),
        max_attempts: integer(form, "max_attempts", 1, 5, 2),
        reboot_policy: ["never", "if_required", "always"].includes(text(form, "reboot_policy", 20))
          ? text(form, "reboot_policy", 20)
          : "never",
        created_by: admin.userId,
      })
      .select("id")
      .single();
    if (policyErr || !policy) {
      back("/dashboard/software", policyErr?.message ?? "Deployment policy creation failed.");
    }

    let deviceIds: string[] = [];
    if (targetDevice) {
      deviceIds = [targetDevice];
    } else if (targetGroup) {
      const { data: members, error: memberErr } = await supabase.rpc("rmm_group_device_ids", {
        p_group_id: targetGroup,
      });
      if (memberErr) back("/dashboard/software", memberErr.message);
      deviceIds = (members ?? [])
        .map((row: any) => (typeof row === "string" ? row : row?.rmm_group_device_ids ?? row?.id))
        .filter((value: unknown): value is string => typeof value === "string");
    }

    if (deviceIds.length === 0) {
      await supabase.from("deployment_policies").delete().eq("id", policy.id);
      back("/dashboard/software", "The selected target has no enrolled devices.");
    }

    // Dependency validation: a missing prerequisite blocks the job instead of
    // letting the agent fail it after download.
    const prerequisites = Array.isArray(versionRow.prerequisites) ? versionRow.prerequisites : [];
    const requiredSoftware = prerequisites
      .filter((p: any) => p && p.type === "installed_software" && typeof p.name === "string")
      .map((p: any) => p.name.toLowerCase());

    let missingSoftware = new Set<string>();
    if (requiredSoftware.length > 0) {
      const { data: installed } = await supabase
        .from("device_software")
        .select("device_id, name")
        .in("device_id", deviceIds);
      for (const requirement of requiredSoftware) {
        for (const deviceId of deviceIds) {
          const present = (installed ?? []).some(
            (row: any) =>
              row.device_id === deviceId &&
              typeof row.name === "string" &&
              row.name.toLowerCase().includes(requirement)
          );
          if (!present) missingSoftware.add(requirement);
        }
      }
    }

    const scheduledFor =
      text(form, "schedule_at", 40) || new Date().toISOString();

    const jobs = deviceIds.map((deviceId) => ({
      organization_id: admin.organizationId,
      device_id: deviceId,
      package_version_id: deployVersionId,
      policy_id: policy.id,
      operation,
      state: missingSoftware.size > 0 ? "blocked" : "queued",
      scheduled_for: scheduledFor,
      max_attempts: integer(form, "max_attempts", 1, 5, 2),
      requested_by: admin.userId,
      idempotency_key: `${policy.id}:${deviceId}`,
      error_summary:
        missingSoftware.size > 0
          ? `Missing prerequisite: ${Array.from(missingSoftware).join(", ")}`
          : null,
      completed_at: missingSoftware.size > 0 ? new Date().toISOString() : null,
    }));

    const { error: jobErr } = await supabase.from("deployment_jobs").insert(jobs);
    if (jobErr) {
      await supabase.from("deployment_policies").delete().eq("id", policy.id);
      back("/dashboard/software", jobErr.message);
    }

    await audit(admin.organizationId, admin.userId, "deployment.created", "deployment_policy", policy.id, {
      package_version_id: deployVersionId,
      requested_version_id: versionId,
      operation,
      target_device: targetDevice,
      target_group: targetGroup,
      device_count: deviceIds.length,
      blocked_by_dependency: missingSoftware.size > 0,
    });

    await audit(admin.organizationId, admin.userId, "deployment.dispatched", "deployment_policy", policy.id, {
      device_count: deviceIds.length,
    });

    revalidatePath("/dashboard/deployments");
    back("/dashboard/deployments");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/software", error instanceof Error ? error.message : "Deployment creation failed.");
  }
}

export async function cancelDeploymentAction(form: FormData): Promise<void> {
  const id = uuid(text(form, "job_id", 40));
  const returnPath = text(form, "return_path", 200) || "/dashboard/deployments";
  try {
    const admin = await requireAdmin();
    if (!id) back(returnPath, "Invalid deployment.");
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("rmm_cancel_deployment", {
      p_job_id: id,
      p_actor_user_id: admin.userId,
      p_org_id: admin.organizationId,
    });
    if (error) back(returnPath, error.message);
    if (data !== "ok") back(returnPath, "Deployment could not be cancelled: " + String(data));
    revalidatePath("/dashboard/deployments");
    back(returnPath);
  } catch (error) {
    if (isRedirect(error)) throw error;
    back(returnPath, error instanceof Error ? error.message : "Cancel failed.");
  }
}

export async function retryDeploymentAction(form: FormData): Promise<void> {
  const id = uuid(text(form, "job_id", 40));
  const returnPath = text(form, "return_path", 200) || "/dashboard/deployments";
  try {
    const admin = await requireAdmin();
    if (!id) back(returnPath, "Invalid deployment.");
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("rmm_retry_deployment", {
      p_job_id: id,
      p_actor_user_id: admin.userId,
      p_org_id: admin.organizationId,
    });
    if (error) back(returnPath, error.message);
    if (data !== "ok") {
      back(returnPath, "Retry not allowed: " + String(data));
    }
    revalidatePath("/dashboard/deployments");
    back(returnPath);
  } catch (error) {
    if (isRedirect(error)) throw error;
    back(returnPath, error instanceof Error ? error.message : "Retry failed.");
  }
}

// ---------------------------------------------------------------------
// Device groups
// ---------------------------------------------------------------------

export async function createGroupAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();
    const name = text(form, "name", 120);
    if (!name) back("/dashboard/groups", "Group name is required.");

    const type = text(form, "group_type", 20) === "dynamic" ? "dynamic" : "static";
    const rules = type === "dynamic"
      ? jsonObject(text(form, "dynamic_rules", 16384), "Dynamic rules")
      : {};

    const { data, error } = await supabase
      .from("device_groups")
      .insert({
        organization_id: admin.organizationId,
        name,
        description: optionalText(form, "description", 500),
        group_type: type,
        dynamic_rules: rules,
        created_by: admin.userId,
      })
      .select("id")
      .single();
    if (error) back("/dashboard/groups", error.message);

    await audit(admin.organizationId, admin.userId, "device_group.created", "device_group", data?.id ?? null, {
      name, group_type: type,
    });
    revalidatePath("/dashboard/groups");
    back("/dashboard/groups");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/groups", error instanceof Error ? error.message : "Failed to create group.");
  }
}

export async function updateGroupMembershipAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const groupId = uuid(text(form, "group_id", 40));
    const deviceId = uuid(text(form, "device_id", 40));
    const remove = text(form, "remove", 10) === "true";
    if (!groupId || !deviceId) back("/dashboard/groups", "Invalid group membership.");

    const supabase = createServiceClient();
    const { data: group } = await supabase
      .from("device_groups")
      .select("organization_id, group_type")
      .eq("id", groupId)
      .maybeSingle();
    if (!group || group.organization_id !== admin.organizationId) {
      back("/dashboard/groups", "Group not found.");
    }
    if (group.group_type !== "static") {
      back("/dashboard/groups", "Dynamic groups are evaluated from rules; edit the rules instead.");
    }

    const { data: device } = await supabase
      .from("devices")
      .select("organization_id")
      .eq("id", deviceId)
      .maybeSingle();
    if (!device || device.organization_id !== admin.organizationId) {
      back("/dashboard/groups", "Device not found.");
    }

    if (remove) {
      await supabase.from("device_group_members").delete().eq("group_id", groupId).eq("device_id", deviceId);
    } else {
      await supabase
        .from("device_group_members")
        .upsert({ group_id: groupId, device_id: deviceId }, { onConflict: "group_id,device_id" });
    }

    await audit(
      admin.organizationId,
      admin.userId,
      remove ? "device_group.member_removed" : "device_group.member_added",
      "device_group",
      groupId,
      { device_id: deviceId }
    );
    revalidatePath("/dashboard/groups");
    back("/dashboard/groups");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/groups", error instanceof Error ? error.message : "Membership update failed.");
  }
}

// ---------------------------------------------------------------------
// RMM settings
// ---------------------------------------------------------------------

export async function updateRmmSettingsAction(form: FormData): Promise<void> {
  try {
    const admin = await requireAdmin();
    const supabase = createServiceClient();
    const updates = {
      offline_after_seconds: integer(form, "offline_after_seconds", 60, 86400, 300),
      metrics_interval_seconds: integer(form, "metrics_interval_seconds", 10, 3600, 60),
      inventory_interval_seconds: integer(form, "inventory_interval_seconds", 300, 604800, 21600),
      software_scan_interval_seconds: integer(form, "software_scan_interval_seconds", 300, 604800, 21600),
      event_scan_interval_seconds: integer(form, "event_scan_interval_seconds", 60, 86400, 300),
      metrics_retention_days: integer(form, "metrics_retention_days", 1, 3650, 30),
      monitor_results_retention_days: integer(form, "monitor_results_retention_days", 1, 3650, 30),
      event_retention_days: integer(form, "event_retention_days", 1, 3650, 30),
      deployment_concurrency_limit: integer(form, "deployment_concurrency_limit", 1, 100, 5),
      allow_custom_powershell_monitors: text(form, "allow_custom_powershell_monitors", 10) === "on",
      allow_security_event_collection: text(form, "allow_security_event_collection", 10) === "on",
      allow_service_recovery: text(form, "allow_service_recovery", 10) === "on",
      service_recovery_cooldown_seconds: integer(form, "service_recovery_cooldown_seconds", 60, 86400, 600),
    };

    const { error } = await supabase
      .from("organization_settings")
      .update(updates)
      .eq("organization_id", admin.organizationId);
    if (error) back("/dashboard/settings", error.message);

    await audit(admin.organizationId, admin.userId, "rmm.settings_updated", "organization_settings",
      admin.organizationId, updates);
    revalidatePath("/dashboard/settings");
    back("/dashboard/settings");
  } catch (error) {
    if (isRedirect(error)) throw error;
    back("/dashboard/settings", error instanceof Error ? error.message : "Settings update failed.");
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
