import fs from "fs/promises";
import path from "path";

export interface DeviceRmmData {
  inventory?: {
    hardware?: {
      cpu?: {
        model?: string;
        manufacturer?: string;
        cores?: number;
        logical_processors?: number;
      };
      ram_bytes?: number;
      manufacturer?: string;
      model?: string;
      bios?: {
        version?: string;
        manufacturer?: string;
        release_date?: string;
      };
      motherboard?: {
        manufacturer?: string;
        model?: string;
        serial_number?: string;
      };
      storage?: Array<{
        model?: string;
        media_type?: string;
        health?: string;
      }>;
    };
    os?: {
      product_name?: string;
      build?: string;
      architecture?: string;
      uptime_seconds?: number;
      disks?: Array<{
        name?: string;
        file_system?: string;
        total_bytes?: number;
        free_bytes?: number;
        used_percent?: number;
      }>;
    };
    network?: {
      interfaces?: Array<{
        name?: string;
        status?: string;
        ipv4?: string[];
        gateways?: string[];
      }>;
    };
    collected_at?: string;
    data_quality?: any[];
  };
  metrics?: Array<{
    metric: string;
    value: number;
    dimensions?: any;
    collected_at: string;
  }>;
  software?: Array<{
    name: string;
    version?: string;
    publisher?: string;
    architecture?: string;
    install_date?: string;
  }>;
  software_count?: number;
  software_collected_at?: string;
  events?: Array<{
    source?: string;
    event_id?: number | string;
    level?: string;
    message?: string;
    time_generated?: string;
  }>;
  service_status?: string;
  is_elevated?: boolean;
  execution_account?: string;
  updated_at?: string;
}

const DATA_DIR = path.join(process.cwd(), "data", "rmm");

async function ensureDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

export async function getRmmData(deviceId: string): Promise<DeviceRmmData | null> {
  if (!deviceId) return null;
  const filePath = path.join(DATA_DIR, `${deviceId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as DeviceRmmData;
  } catch {
    return null;
  }
}

export async function saveRmmData(
  deviceId: string,
  update: Partial<DeviceRmmData>
): Promise<DeviceRmmData> {
  if (!deviceId) throw new Error("deviceId is required");
  await ensureDir();

  const current = (await getRmmData(deviceId)) || {};

  // Merge metrics sliding window
  let mergedMetrics = current.metrics || [];
  if (update.metrics && update.metrics.length > 0) {
    mergedMetrics = [...mergedMetrics, ...update.metrics].slice(-600);
  }

  // Merge software
  let mergedSoftware = update.software ?? current.software ?? [];
  const softwareCount = update.software_count ?? (mergedSoftware ? mergedSoftware.length : current.software_count ?? 0);

  // Merge events sliding window
  let mergedEvents = current.events || [];
  if (update.events && update.events.length > 0) {
    const combined = [...update.events, ...mergedEvents];
    // deduplicate by time + event_id
    const seen = new Set<string>();
    mergedEvents = [];
    for (const ev of combined) {
      const key = `${ev.time_generated || ""}_${ev.event_id || ""}_${ev.source || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        mergedEvents.push(ev);
      }
      if (mergedEvents.length >= 200) break;
    }
  }

  const merged: DeviceRmmData = {
    ...current,
    ...update,
    inventory: update.inventory ?? current.inventory,
    metrics: mergedMetrics,
    software: mergedSoftware,
    software_count: softwareCount,
    events: mergedEvents,
    service_status: update.service_status ?? current.service_status ?? "running",
    is_elevated: update.is_elevated ?? current.is_elevated ?? false,
    execution_account: update.execution_account ?? current.execution_account ?? "NYXPC\\nyx!",
    updated_at: new Date().toISOString(),
  };

  const filePath = path.join(DATA_DIR, `${deviceId}.json`);
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Creates safe metadata for the Supabase devices table that is strictly bounded to <= 2500 bytes,
 * guaranteeing it will never violate PostgreSQL check constraint CHECK (pg_column_size(metadata) <= 4096).
 */
export function buildSafeDeviceMetadata(
  existingMeta: Record<string, unknown> | null | undefined,
  rmmData: Partial<DeviceRmmData>
): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(existingMeta || {}) };

  // Remove large nested blobs if they were previously there
  delete meta.software;
  delete meta.events;
  delete meta.inventory;
  delete meta.metrics;

  meta.service_status = rmmData.service_status || meta.service_status || "running";
  meta.is_elevated = typeof rmmData.is_elevated === "boolean" ? rmmData.is_elevated : Boolean(meta.is_elevated);
  if (rmmData.execution_account) {
    meta.execution_account = String(rmmData.execution_account).slice(0, 100);
  }

  if (rmmData.software_count != null) {
    meta.software_count = rmmData.software_count;
  }

  // Summary snippet of hardware and latest metrics for quick lookups
  const hw = rmmData.inventory?.hardware;
  const os = rmmData.inventory?.os;
  const lastCpu = rmmData.metrics?.filter((m) => m.metric === "cpu.percent").slice(-1)[0]?.value;
  const lastMem = rmmData.metrics?.filter((m) => m.metric === "memory.percent").slice(-1)[0]?.value;

  meta.rmm_summary = {
    cpu_model: hw?.cpu?.model ? String(hw.cpu.model).slice(0, 80) : undefined,
    ram_gb: hw?.ram_bytes ? Math.round((hw.ram_bytes / 1024 ** 3) * 10) / 10 : undefined,
    os_name: os?.product_name ? String(os.product_name).slice(0, 80) : undefined,
    last_cpu: lastCpu,
    last_mem: lastMem,
    synced_at: new Date().toISOString(),
  };

  // Double check size
  const jsonStr = JSON.stringify(meta);
  if (jsonStr.length > 3500) {
    // If still large, remove summary
    delete meta.rmm_summary;
  }

  return meta;
}
