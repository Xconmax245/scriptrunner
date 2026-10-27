using System.Globalization;
using Microsoft.Win32;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Inventory;

/// <summary>
/// Inventories installed applications from the standard Uninstall registry
/// locations (64-bit, 32-bit and per-user). Only metadata is read; no
/// application or installer is executed.
/// </summary>
public sealed class SoftwareInventoryCollector
{
    private static readonly string[] UninstallSubKeys =
    {
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    };

    public Task<SoftwareScanResult> CollectAsync(CancellationToken cancellationToken) =>
        Task.Run(() => Collect(cancellationToken), cancellationToken);

    private SoftwareScanResult Collect(CancellationToken cancellationToken)
    {
        var result = new SoftwareScanResult { CollectedAt = DateTimeOffset.UtcNow };
        if (!OperatingSystem.IsWindows())
        {
            result.Warnings.Add("Software inventory requires Windows.");
            return result;
        }

        var byKey = new Dictionary<string, SoftwareApplication>(StringComparer.OrdinalIgnoreCase);

        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            cancellationToken.ThrowIfCancellationRequested();
            var architecture = view == RegistryView.Registry64 ? "x64" : "x86";
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                foreach (var subKey in UninstallSubKeys)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ReadUninstallKey(baseKey, subKey, architecture, "machine", byKey, result.Warnings,
                        cancellationToken);
                }
            }
            catch (Exception ex)
            {
                result.Warnings.Add($"Machine software inventory ({architecture}) failed: {ex.Message}");
            }
        }

        try
        {
            using var currentUser = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default);
            ReadUninstallKey(
                currentUser,
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                "any",
                "user",
                byKey,
                result.Warnings,
                cancellationToken);
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Per-user software inventory failed: " + ex.Message);
        }

        result.Applications = byKey.Values
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return result;
    }

    private static void ReadUninstallKey(
        RegistryKey baseKey,
        string subKeyPath,
        string architecture,
        string scope,
        Dictionary<string, SoftwareApplication> byKey,
        List<string> warnings,
        CancellationToken cancellationToken)
    {
        using var uninstall = baseKey.OpenSubKey(subKeyPath);
        if (uninstall is null) return;

        foreach (var name in uninstall.GetSubKeyNames())
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var appKey = uninstall.OpenSubKey(name);
                if (appKey is null) continue;

                var displayName = (appKey.GetValue("DisplayName") as string)?.Trim();
                if (string.IsNullOrWhiteSpace(displayName)) continue;

                // Updates and OS components are not applications.
                if (Convert.ToInt32(appKey.GetValue("SystemComponent") ?? 0, CultureInfo.InvariantCulture) == 1)
                {
                    continue;
                }
                if (appKey.GetValue("ParentKeyName") is string parent && !string.IsNullOrWhiteSpace(parent))
                {
                    continue;
                }

                var publisher = (appKey.GetValue("Publisher") as string)?.Trim();
                var version = (appKey.GetValue("DisplayVersion") as string)?.Trim();
                var installLocation = (appKey.GetValue("InstallSource") as string)?.Trim()
                    ?? (appKey.GetValue("InstallLocation") as string)?.Trim();

                var normalizedName = Normalize(displayName);
                var normalizedPublisher = Normalize(publisher);
                var key = $"{normalizedName}|{normalizedPublisher}|{architecture}";
                if (key.Length > 400) key = key[..400];

                // The same MSI can appear in both 32- and 64-bit views; keep the
                // entry that carries the richest metadata.
                var app = new SoftwareApplication
                {
                    ProductKey = key,
                    Name = Truncate(displayName, 300)!,
                    Publisher = Truncate(publisher, 300),
                    Version = Truncate(version, 80),
                    Architecture = architecture,
                    InstallDate = ParseInstallDate(appKey.GetValue("InstallDate")?.ToString()),
                    InstallSource = Truncate(installLocation, 1000),
                    ProductCode = name.StartsWith('{') ? Truncate(name, 100) : null,
                    Scope = scope
                };

                if (!byKey.TryGetValue(key, out var existing)
                    || Score(app) > Score(existing))
                {
                    byKey[key] = app;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("An uninstall entry could not be read: " + ex.Message);
            }
        }
    }

    private static int Score(SoftwareApplication app)
    {
        var score = 0;
        if (!string.IsNullOrEmpty(app.ProductCode)) score += 4;
        if (!string.IsNullOrEmpty(app.Version)) score += 2;
        if (!string.IsNullOrEmpty(app.Publisher)) score += 1;
        if (!string.IsNullOrEmpty(app.InstallDate)) score += 1;
        return score;
    }

    private static string Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : value.Trim().ToLowerInvariant();

    private static string? Truncate(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= max ? trimmed : trimmed[..max];
    }

    private static string? ParseInstallDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (DateTime.TryParseExact(value.Trim(), "yyyyMMdd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var compact))
        {
            return compact.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        return null;
    }
}
