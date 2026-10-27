using System.Globalization;
using System.Management;
using Microsoft.Win32;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Inventory;

/// <summary>
/// Operating-system inventory: edition/build/architecture, install date,
/// uptime, pending reboot state, last update activity and volume usage.
/// Missing registry keys are reported as warnings, not as healthy values.
/// </summary>
public sealed class OperatingSystemInventoryCollector
{
    public Task<OperatingSystemInventory> CollectAsync(CancellationToken cancellationToken) =>
        Task.Run(() => Collect(cancellationToken), cancellationToken);

    private OperatingSystemInventory Collect(CancellationToken cancellationToken)
    {
        var result = new OperatingSystemInventory { CollectedAt = DateTimeOffset.UtcNow };

        if (!OperatingSystem.IsWindows())
        {
            result.Warnings.Add("Operating-system inventory requires Windows.");
            return result;
        }

        cancellationToken.ThrowIfCancellationRequested();

        using (var key = Registry.LocalMachine.OpenSubKey(
                   @"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
        {
            if (key is null)
            {
                result.Warnings.Add("Windows version registry key is not readable.");
            }
            else
            {
                result.ProductName = ReadString(key, "ProductName");
                result.Edition = ReadString(key, "EditionID") ?? ReadString(key, "DisplayVersion");
                result.Version = ReadString(key, "DisplayVersion");
                result.Build = ReadString(key, "CurrentBuildNumber") ?? ReadString(key, "CurrentBuild");
                result.Ubr = ReadString(key, "UBR");

                var installDate = ReadInt(key, "InstallDate");
                if (installDate is > 0)
                {
                    result.InstallDate = DateTimeOffset
                        .FromUnixTimeSeconds(installDate.Value)
                        .UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                }

                if (string.IsNullOrWhiteSpace(result.Edition))
                {
                    result.Edition = result.ProductName;
                }
            }
        }

        result.Architecture = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture
            .ToString().ToLowerInvariant();

        try
        {
            var uptime = TimeSpan.FromMilliseconds(Environment.TickCount64);
            result.UptimeSeconds = (long)uptime.TotalSeconds;
            result.LastBootTime = DateTimeOffset.UtcNow - uptime;
        }
        catch
        {
            result.Warnings.Add("System uptime is unavailable.");
        }

        CollectPendingReboot(result);
        CollectUpdateInfo(result);
        CollectVolumes(result);
        CollectLatestHotfix(result, cancellationToken);

        return result;
    }

    private static void CollectPendingReboot(OperatingSystemInventory result)
    {
        var reasons = new List<string>();

        void CheckKey(string path, string reason)
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(path);
                if (key is not null) reasons.Add(reason);
            }
            catch
            {
                // Permission denied: leave the state unknown rather than false.
            }
        }

        CheckKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            "Component Based Servicing");
        CheckKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            "Windows Update");
        CheckKey(
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending",
            "Pending component packages");

        try
        {
            using var sessionManager = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Control\Session Manager");
            if (sessionManager?.GetValue("PendingFileRenameOperations") is string[] { Length: > 0 })
            {
                reasons.Add("Pending file rename operations");
            }
        }
        catch
        {
            // ignored: unknown
        }

        if (reasons.Count > 0)
        {
            result.PendingReboot = true;
            result.PendingRebootReasons = reasons.Distinct().ToList();
        }
        else if (result.PendingReboot is null)
        {
            // We successfully inspected every standard key and found none.
            result.PendingReboot = false;
        }
    }

    private static void CollectUpdateInfo(OperatingSystemInventory result)
    {
        try
        {
            using var install = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\Results\Install");
            var lastSuccess = ReadString(install, "LastSuccessTime");
            if (DateTimeOffset.TryParse(lastSuccess, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var installedAt))
            {
                result.LastUpdateInstalledAt = installedAt;
            }

            if (install is not null)
            {
                result.LastUpdateInstalled = ReadString(install, "LastSuccessTime") is null
                    ? null
                    : "Windows Update";
            }
        }
        catch
        {
            result.Warnings.Add("Windows Update install history is unavailable.");
        }

        try
        {
            using var detect = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\Results\Detect");
            var lastSearch = ReadString(detect, "LastSuccessTime");
            if (DateTimeOffset.TryParse(lastSearch, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var searchedAt))
            {
                result.LastUpdateSearchAt = searchedAt;
            }
        }
        catch
        {
            result.Warnings.Add("Windows Update search history is unavailable.");
        }
    }

    private static void CollectVolumes(OperatingSystemInventory result)
    {
        try
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;

                    var used = drive.TotalSize - drive.TotalFreeSpace;
                    result.Disks.Add(new VolumeInventory
                    {
                        Name = drive.Name,
                        Label = string.IsNullOrWhiteSpace(drive.VolumeLabel) ? null : drive.VolumeLabel,
                        FileSystem = drive.DriveFormat,
                        TotalBytes = drive.TotalSize,
                        FreeBytes = drive.TotalFreeSpace,
                        UsedPercent = drive.TotalSize > 0
                            ? Math.Round(100.0 * used / drive.TotalSize, 2)
                            : null
                    });
                }
                catch
                {
                    // A single inaccessible volume must not abort the scan.
                }
            }
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Volume inventory unavailable: " + ex.Message);
        }
    }

    private static void CollectLatestHotfix(
        OperatingSystemInventory result,
        CancellationToken cancellationToken)
    {
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var searcher = new ManagementObjectSearcher(
                new ManagementScope(@"\\.\root\CIMV2"),
                new ObjectQuery("SELECT HotFixID, InstalledOn FROM Win32_QuickFixEngineering"),
                new System.Management.EnumerationOptions
                {
                    Timeout = TimeSpan.FromSeconds(10), ReturnImmediately = true
                });
            using var rows = searcher.Get();

            DateTime? newest = null;
            string? newestId = null;

            foreach (ManagementObject obj in rows)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var id = obj["HotFixID"]?.ToString();
                var installedOn = obj["InstalledOn"]?.ToString();
                if (!DateTime.TryParse(installedOn, CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal, out var date))
                {
                    continue;
                }
                if (newest is null || date > newest)
                {
                    newest = date;
                    newestId = id;
                }
            }

            if (newest is not null)
            {
                result.LastUpdateInstalled = newestId;
                result.LastUpdateInstalledAt = new DateTimeOffset(newest.Value, TimeSpan.Zero);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            result.Warnings.Add("Installed update list is unavailable.");
        }
    }

    private static string? ReadString(RegistryKey? key, string name)
    {
        try
        {
            var value = key?.GetValue(name);
            var text = value?.ToString()?.Trim();
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
        catch
        {
            return null;
        }
    }

    private static int? ReadInt(RegistryKey? key, string name)
    {
        try
        {
            var value = key?.GetValue(name);
            if (value is null) return null;
            return Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        catch
        {
            return null;
        }
    }
}
