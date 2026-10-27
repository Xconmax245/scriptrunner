using System.Management;
using Microsoft.Extensions.Logging;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Inventory;

/// <summary>
/// Collects hardware inventory through WMI/CIM.
///
/// Every query is isolated: a missing class, a permission failure or a
/// virtualised/restricted field produces a warning entry instead of failing the
/// whole collection. Values that cannot be read are left null rather than being
/// invented.
/// </summary>
public sealed class HardwareInventoryCollector
{
    private readonly ILogger<HardwareInventoryCollector> _logger;

    public HardwareInventoryCollector(ILogger<HardwareInventoryCollector> logger)
    {
        _logger = logger;
    }

    public Task<HardwareInventory> CollectAsync(CancellationToken cancellationToken) =>
        Task.Run(() => Collect(cancellationToken), cancellationToken);

    private HardwareInventory Collect(CancellationToken cancellationToken)
    {
        var result = new HardwareInventory { CollectedAt = DateTimeOffset.UtcNow };

        if (!OperatingSystem.IsWindows())
        {
            result.Warnings.Add("Hardware inventory requires Windows.");
            return result;
        }

        cancellationToken.ThrowIfCancellationRequested();

        result.Cpu = CollectCpu(result.Warnings);
        CollectMemory(result);
        result.Motherboard = CollectMotherboard(result.Warnings);
        result.Bios = CollectBios(result.Warnings);
        CollectComputerSystem(result);
        CollectStorage(result);

        return result;
    }

    private CpuInventory? CollectCpu(List<string> warnings)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2",
                "SELECT Manufacturer, Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, AddressWidth FROM Win32_Processor");
            using var results = searcher.Get();
            var cpu = new CpuInventory();
            foreach (ManagementObject obj in results)
            {
                cpu.Manufacturer ??= GetString(obj, "Manufacturer");
                cpu.Model ??= GetString(obj, "Name");
                cpu.Cores ??= GetInt(obj, "NumberOfCores");
                cpu.LogicalProcessors ??= GetInt(obj, "NumberOfLogicalProcessors");
                cpu.MaxClockMhz ??= GetInt(obj, "MaxClockSpeed");
                cpu.Architecture ??= GetInt(obj, "AddressWidth") switch
                {
                    64 => "x64",
                    32 => "x86",
                    _ => null
                };
                break;
            }
            return cpu;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("CPU inventory query failed: {Message}", ex.Message);
            warnings.Add("CPU inventory unavailable: " + ex.Message);
            return null;
        }
    }

    private void CollectMemory(HardwareInventory result)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2",
                "SELECT Manufacturer, PartNumber, Capacity, Speed, DeviceLocator FROM Win32_PhysicalMemory");
            using var modules = searcher.Get();
            long total = 0;
            foreach (ManagementObject obj in modules)
            {
                var capacity = GetLong(obj, "Capacity");
                result.MemoryModules.Add(new MemoryModuleInventory
                {
                    Manufacturer = GetString(obj, "Manufacturer"),
                    PartNumber = GetString(obj, "PartNumber"),
                    CapacityBytes = capacity,
                    SpeedMhz = GetInt(obj, "Speed"),
                    Slot = GetString(obj, "DeviceLocator")
                });
                if (capacity.HasValue) total += capacity.Value;
            }
            if (total > 0) result.RamBytes = total;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Memory inventory query failed: {Message}", ex.Message);
            result.Warnings.Add("Memory module details unavailable: " + ex.Message);
        }

        // Win32_ComputerSystem.TotalPhysicalMemory is a reliable fallback that
        // also works in virtual machines where Win32_PhysicalMemory is sparse.
        if (result.RamBytes is null or 0)
        {
            try
            {
                using var searcher = new ManagementObjectSearcher(
                    "root\\CIMV2", "SELECT TotalPhysicalMemory FROM Win32_ComputerSystem");
                using var rows = searcher.Get();
                foreach (ManagementObject obj in rows)
                {
                    result.RamBytes = GetLong(obj, "TotalPhysicalMemory");
                    break;
                }
            }
            catch (Exception ex)
            {
                result.Warnings.Add("Installed RAM unavailable: " + ex.Message);
            }
        }
    }

    private MotherboardInventory? CollectMotherboard(List<string> warnings)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2", "SELECT Manufacturer, Product, SerialNumber, Version FROM Win32_BaseBoard");
            using var rows = searcher.Get();
            foreach (ManagementObject obj in rows)
            {
                return new MotherboardInventory
                {
                    Manufacturer = GetString(obj, "Manufacturer"),
                    Model = GetString(obj, "Product"),
                    SerialNumber = CleanSerial(GetString(obj, "SerialNumber")),
                    Version = GetString(obj, "Version")
                };
            }
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug("Motherboard inventory unavailable: {Message}", ex.Message);
            warnings.Add("Motherboard inventory unavailable: " + ex.Message);
            return null;
        }
    }

    private BiosInventory? CollectBios(List<string> warnings)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2",
                "SELECT Manufacturer, SMBIOSBIOSVersion, SerialNumber, ReleaseDate FROM Win32_BIOS");
            using var rows = searcher.Get();
            foreach (ManagementObject obj in rows)
            {
                return new BiosInventory
                {
                    Manufacturer = GetString(obj, "Manufacturer"),
                    Version = GetString(obj, "SMBIOSBIOSVersion"),
                    SerialNumber = CleanSerial(GetString(obj, "SerialNumber")),
                    ReleaseDate = ParseWmiDate(GetString(obj, "ReleaseDate"))
                };
            }
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug("BIOS inventory unavailable: {Message}", ex.Message);
            warnings.Add("BIOS inventory unavailable: " + ex.Message);
            return null;
        }
    }

    private void CollectComputerSystem(HardwareInventory result)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2", "SELECT Manufacturer, Model FROM Win32_ComputerSystem");
            using var rows = searcher.Get();
            foreach (ManagementObject obj in rows)
            {
                result.Manufacturer = GetString(obj, "Manufacturer");
                result.Model = GetString(obj, "Model");
                break;
            }
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Computer system model unavailable: " + ex.Message);
        }

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2",
                "SELECT IdentifyingNumber, UUID FROM Win32_ComputerSystemProduct");
            using var rows = searcher.Get();
            foreach (ManagementObject obj in rows)
            {
                result.SerialNumber = CleanSerial(GetString(obj, "IdentifyingNumber"));
                result.DeviceId = GetString(obj, "UUID");
                break;
            }
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Device serial number unavailable: " + ex.Message);
        }
    }

    private void CollectStorage(HardwareInventory result)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\CIMV2",
                "SELECT DeviceID, Model, SerialNumber, Size, MediaType, InterfaceType, Status FROM Win32_DiskDrive");
            using var rows = searcher.Get();
            foreach (ManagementObject obj in rows)
            {
                var status = GetString(obj, "Status");
                var mediaType = GetString(obj, "MediaType");
                result.Storage.Add(new StorageDeviceInventory
                {
                    DeviceId = GetString(obj, "DeviceID"),
                    Model = GetString(obj, "Model"),
                    SerialNumber = CleanSerial(GetString(obj, "SerialNumber")),
                    SizeBytes = GetLong(obj, "Size"),
                    MediaType = NormalizeMediaType(mediaType),
                    BusType = GetString(obj, "InterfaceType"),
                    Health = string.IsNullOrEmpty(status)
                        ? "unavailable"
                        : status.Equals("OK", StringComparison.OrdinalIgnoreCase) ? "healthy" : "warning",
                    HealthDetail = status
                });
            }
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Disk inventory unavailable: " + ex.Message);
        }

        // SMBIOS/firmware health is only available on some systems. Failure here
        // must not be mistaken for an unhealthy disk.
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "root\\Microsoft\\Windows\\Storage",
                "SELECT FriendlyName, SerialNumber, MediaType, BusType, HealthStatus FROM MSFT_PhysicalDisk");
            using var rows = searcher.Get();
            var byModel = result.Storage
                .GroupBy(s => s.Model ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            foreach (ManagementObject obj in rows)
            {
                var name = GetString(obj, "FriendlyName") ?? string.Empty;
                var healthStatus = GetInt(obj, "HealthStatus");
                var media = GetInt(obj, "MediaType");
                var bus = GetInt(obj, "BusType");

                StorageDeviceInventory? target = null;
                if (byModel.TryGetValue(name, out var match)) target = match;

                if (target is null)
                {
                    target = new StorageDeviceInventory
                    {
                        Model = name,
                        SerialNumber = CleanSerial(GetString(obj, "SerialNumber")),
                        MediaType = media switch { 3 => "HDD", 4 => "SSD", _ => "Unknown" },
                        BusType = bus switch
                        {
                            7 => "USB", 8 => "RAID", 11 => "SATA", 17 => "NVMe", _ => "Unknown"
                        }
                    };
                    result.Storage.Add(target);
                }

                target.Health = healthStatus switch
                {
                    0 => "healthy",
                    1 => "warning",
                    2 => "unhealthy",
                    _ => "unavailable"
                };
                target.HealthDetail = healthStatus switch
                {
                    0 => "Storage provider reports healthy",
                    1 => "Storage provider reports warning",
                    2 => "Storage provider reports unhealthy",
                    _ => "Storage provider did not report health"
                };
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug("Physical disk health unavailable: {Message}", ex.Message);
            result.Warnings.Add("Physical disk health unavailable: " + ex.Message);
        }
    }

    private static string? NormalizeMediaType(string? mediaType)
    {
        if (string.IsNullOrWhiteSpace(mediaType)) return "Unknown";
        if (mediaType.Contains("SSD", StringComparison.OrdinalIgnoreCase)) return "SSD";
        if (mediaType.Contains("NVMe", StringComparison.OrdinalIgnoreCase)) return "NVMe";
        if (mediaType.Contains("Fixed", StringComparison.OrdinalIgnoreCase)
            || mediaType.Contains("Hard", StringComparison.OrdinalIgnoreCase)) return "HDD";
        return mediaType;
    }

    private static string? CleanSerial(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        if (trimmed.Equals("To be filled by O.E.M.", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("Default string", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("0", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("None", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return trimmed;
    }

    private static string? GetString(ManagementBaseObject obj, string property)
    {
        try
        {
            var value = obj[property];
            var text = value?.ToString()?.Trim();
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
        catch
        {
            return null;
        }
    }

    private static int? GetInt(ManagementBaseObject obj, string property)
    {
        try
        {
            var value = obj[property];
            if (value is null) return null;
            return Convert.ToInt32(value);
        }
        catch
        {
            return null;
        }
    }

    private static long? GetLong(ManagementBaseObject obj, string property)
    {
        try
        {
            var value = obj[property];
            if (value is null) return null;
            return Convert.ToInt64(value);
        }
        catch
        {
            return null;
        }
    }

    private static DateTimeOffset? ParseWmiDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length < 8) return null;
        return DateTime.TryParseExact(
            value[..8],
            "yyyyMMdd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal,
            out var parsed)
            ? new DateTimeOffset(parsed, TimeSpan.Zero)
            : null;
    }
}
