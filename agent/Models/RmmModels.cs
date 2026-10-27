using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptRunnerAgent.Models;

// =========================================================================
// Inventory
// =========================================================================

public sealed class HardwareInventory
{
    public CpuInventory? Cpu { get; set; }
    public long? RamBytes { get; set; }
    public List<MemoryModuleInventory> MemoryModules { get; set; } = new();
    public MotherboardInventory? Motherboard { get; set; }
    public BiosInventory? Bios { get; set; }
    public string? Manufacturer { get; set; }
    public string? Model { get; set; }
    public string? SerialNumber { get; set; }
    public string? DeviceId { get; set; }
    public List<StorageDeviceInventory> Storage { get; set; } = new();
    public DateTimeOffset CollectedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<string> Warnings { get; set; } = new();
}

public sealed class CpuInventory
{
    public string? Manufacturer { get; set; }
    public string? Model { get; set; }
    public int? Cores { get; set; }
    public int? LogicalProcessors { get; set; }
    public int? MaxClockMhz { get; set; }
    public string? Architecture { get; set; }
}

public sealed class MemoryModuleInventory
{
    public string? Manufacturer { get; set; }
    public string? PartNumber { get; set; }
    public long? CapacityBytes { get; set; }
    public int? SpeedMhz { get; set; }
    public string? Slot { get; set; }
}

public sealed class MotherboardInventory
{
    public string? Manufacturer { get; set; }
    public string? Model { get; set; }
    public string? SerialNumber { get; set; }
    public string? Version { get; set; }
}

public sealed class BiosInventory
{
    public string? Manufacturer { get; set; }
    public string? Version { get; set; }
    public string? SerialNumber { get; set; }
    public DateTimeOffset? ReleaseDate { get; set; }
}

public sealed class StorageDeviceInventory
{
    public string? DeviceId { get; set; }
    public string? Model { get; set; }
    public string? SerialNumber { get; set; }
    public long? SizeBytes { get; set; }
    /// <summary>SSD, HDD, NVMe, Unknown.</summary>
    public string? MediaType { get; set; }
    public string? BusType { get; set; }
    /// <summary>healthy, warning, unhealthy, unavailable. Never invented.</summary>
    public string Health { get; set; } = "unavailable";
    public string? HealthDetail { get; set; }
}

public sealed class OperatingSystemInventory
{
    public string? ProductName { get; set; }
    public string? Edition { get; set; }
    public string? Version { get; set; }
    public string? Build { get; set; }
    public string? Ubr { get; set; }
    public string? Architecture { get; set; }
    public string? InstallDate { get; set; }
    public long? UptimeSeconds { get; set; }
    public DateTimeOffset? LastBootTime { get; set; }
    public bool? PendingReboot { get; set; }
    public List<string> PendingRebootReasons { get; set; } = new();
    public string? LastUpdateInstalled { get; set; }
    public DateTimeOffset? LastUpdateInstalledAt { get; set; }
    public DateTimeOffset? LastUpdateSearchAt { get; set; }
    public List<VolumeInventory> Disks { get; set; } = new();
    public DateTimeOffset CollectedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<string> Warnings { get; set; } = new();
}

public sealed class VolumeInventory
{
    public string? Name { get; set; }
    public string? Label { get; set; }
    public string? FileSystem { get; set; }
    public long? TotalBytes { get; set; }
    public long? FreeBytes { get; set; }
    public double? UsedPercent { get; set; }
}

public sealed class NetworkInventory
{
    public List<NetworkAdapterInventory> Interfaces { get; set; } = new();
    public DateTimeOffset CollectedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<string> Warnings { get; set; } = new();
}

public sealed class NetworkAdapterInventory
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? MacAddress { get; set; }
    public string? Type { get; set; }
    public string? Status { get; set; }
    public long? SpeedBitsPerSecond { get; set; }
    public List<string> Ipv4 { get; set; } = new();
    public List<string> Ipv6 { get; set; } = new();
    public List<string> Gateways { get; set; } = new();
    public List<string> DnsServers { get; set; } = new();
}

public sealed class SoftwareApplication
{
    [JsonPropertyName("product_key")] public string ProductKey { get; set; } = string.Empty;
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("publisher")] public string? Publisher { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("architecture")] public string? Architecture { get; set; }
    [JsonPropertyName("install_date")] public string? InstallDate { get; set; }
    [JsonPropertyName("install_source")] public string? InstallSource { get; set; }
    [JsonPropertyName("product_code")] public string? ProductCode { get; set; }
    [JsonPropertyName("scope")] public string Scope { get; set; } = "machine";
}

public sealed class SoftwareScanResult
{
    public List<SoftwareApplication> Applications { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
    public DateTimeOffset CollectedAt { get; set; } = DateTimeOffset.UtcNow;
}

// =========================================================================
// Telemetry
// =========================================================================

public sealed class MetricSample
{
    [JsonPropertyName("metric")] public string Metric { get; set; } = string.Empty;
    [JsonPropertyName("value")] public double Value { get; set; }
    [JsonPropertyName("dimensions")] public Dictionary<string, object?>? Dimensions { get; set; }
    [JsonPropertyName("collected_at")] public string CollectedAt { get; set; } =
        DateTimeOffset.UtcNow.ToString("o");
}

public sealed class EventLogEntryDto
{
    [JsonPropertyName("log_name")] public string LogName { get; set; } = string.Empty;
    [JsonPropertyName("provider")] public string? Provider { get; set; }
    [JsonPropertyName("event_id")] public int? EventId { get; set; }
    [JsonPropertyName("level")] public string? Level { get; set; }
    [JsonPropertyName("recorded_at")] public string? RecordedAt { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("dedupe_key")] public string DedupeKey { get; set; } = string.Empty;
    [JsonPropertyName("details")] public Dictionary<string, object?>? Details { get; set; }
}

// =========================================================================
// Agent configuration and monitors
// =========================================================================

public sealed class AgentRmmConfig
{
    [JsonPropertyName("server_time")] public DateTimeOffset ServerTime { get; set; }
    [JsonPropertyName("settings")] public AgentRmmSettings Settings { get; set; } = new();
    [JsonPropertyName("monitors")] public List<MonitorDefinition> Monitors { get; set; } = new();
}

public sealed class AgentRmmSettings
{
    [JsonPropertyName("metrics_interval_seconds")] public int MetricsIntervalSeconds { get; set; } = 60;
    [JsonPropertyName("inventory_interval_seconds")] public int InventoryIntervalSeconds { get; set; } = 21600;
    [JsonPropertyName("software_scan_interval_seconds")] public int SoftwareScanIntervalSeconds { get; set; } = 21600;
    [JsonPropertyName("event_scan_interval_seconds")] public int EventScanIntervalSeconds { get; set; } = 300;
    [JsonPropertyName("allow_custom_powershell_monitors")] public bool AllowCustomPowershellMonitors { get; set; }
    [JsonPropertyName("allow_security_event_collection")] public bool AllowSecurityEventCollection { get; set; }
    [JsonPropertyName("allow_service_recovery")] public bool AllowServiceRecovery { get; set; }
    [JsonPropertyName("service_recovery_cooldown_seconds")] public int ServiceRecoveryCooldownSeconds { get; set; } = 600;
    [JsonPropertyName("max_event_bytes_per_scan")] public int MaxEventBytesPerScan { get; set; } = 1048576;
}

public sealed class MonitorDefinition
{
    [JsonPropertyName("id")] public Guid Id { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
    [JsonPropertyName("config")] public JsonElement Config { get; set; }
    [JsonPropertyName("interval_seconds")] public int IntervalSeconds { get; set; } = 60;
    [JsonPropertyName("timeout_seconds")] public int TimeoutSeconds { get; set; } = 30;
    [JsonPropertyName("severity")] public string Severity { get; set; } = "warning";
    [JsonPropertyName("auto_recovery")] public bool AutoRecovery { get; set; }
    [JsonPropertyName("recovery_action")] public JsonElement RecoveryAction { get; set; }
    [JsonPropertyName("last_run_at")] public DateTimeOffset? LastRunAt { get; set; }
}

public sealed class MonitorOutcome
{
    public string Status { get; init; } = "unknown";
    public double? Value { get; init; }
    public string? Message { get; init; }
    public Dictionary<string, object?> Details { get; init; } = new();
    public int DurationMs { get; init; }
    public string? Error { get; init; }
    public bool RecoveryPerformed { get; init; }
    public string? RecoveryNote { get; init; }

    public static MonitorOutcome Unknown(string reason) => new()
    {
        Status = "unknown",
        Message = reason
    };

    public static MonitorOutcome Fault(string error, string? message = null) => new()
    {
        Status = "error",
        Error = error,
        Message = message ?? error
    };
}

// =========================================================================
// Deployments
// =========================================================================

public sealed class DeploymentWorkItem
{
    [JsonPropertyName("job_id")] public Guid JobId { get; set; }
    [JsonPropertyName("package_version_id")] public Guid PackageVersionId { get; set; }
    [JsonPropertyName("operation")] public string Operation { get; set; } = "install";
    [JsonPropertyName("attempt_number")] public int AttemptNumber { get; set; }
    [JsonPropertyName("package_name")] public string PackageName { get; set; } = string.Empty;
    [JsonPropertyName("package_format")] public string PackageFormat { get; set; } = "msi";
    [JsonPropertyName("version")] public string Version { get; set; } = string.Empty;
    [JsonPropertyName("storage_path")] public string StoragePath { get; set; } = string.Empty;
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = string.Empty;
    [JsonPropertyName("file_size_bytes")] public long FileSizeBytes { get; set; }
    [JsonPropertyName("install_args")] public string? InstallArgs { get; set; }
    [JsonPropertyName("uninstall_args")] public string? UninstallArgs { get; set; }
    [JsonPropertyName("repair_args")] public string? RepairArgs { get; set; }
    [JsonPropertyName("detection_rules")] public JsonElement DetectionRules { get; set; }
    [JsonPropertyName("prerequisites")] public JsonElement Prerequisites { get; set; }
    [JsonPropertyName("signature_subject")] public string? SignatureSubject { get; set; }
    [JsonPropertyName("requires_reboot")] public bool RequiresReboot { get; set; }
    [JsonPropertyName("timeout_seconds")] public int TimeoutSeconds { get; set; } = 600;
    [JsonPropertyName("download_url")] public string? DownloadUrl { get; set; }
}
