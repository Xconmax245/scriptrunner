using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Win32;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;

namespace ScriptRunnerAgent.Deployment;

public sealed class DeploymentExecutionResult
{
    public string State { get; init; } = "failed";
    public int? ExitCode { get; init; }
    public string Output { get; init; } = string.Empty;
    public string? Error { get; init; }
    public bool RebootRequired { get; init; }
    public string FailureClass { get; init; } = string.Empty;
}

public sealed class DeploymentPhaseUpdate
{
    public string State { get; init; } = "installing";
    public int Progress { get; init; }
    public string Message { get; init; } = string.Empty;
}

/// <summary>
/// Downloads an approved package, validates its SHA-256 (and optionally its
/// Authenticode signature), executes the package-specific installer silently,
/// and verifies the configured detection rule.
///
/// The executor never decides that a package is safe because of its extension;
/// it only runs packages that were approved server-side and whose hash matches
/// the approved metadata.
/// </summary>
public sealed class SoftwareDeploymentExecutor
{
    private static readonly HttpClient DownloadClient = new()
    {
        Timeout = TimeSpan.FromMinutes(30)
    };

    private readonly IJobExecutionEngine _executionEngine;
    private readonly AgentOptions _options;
    private readonly ILogger<SoftwareDeploymentExecutor> _logger;

    public SoftwareDeploymentExecutor(
        IJobExecutionEngine executionEngine,
        IOptions<AgentOptions> options,
        ILogger<SoftwareDeploymentExecutor> logger)
    {
        _executionEngine = executionEngine;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<DeploymentExecutionResult> ExecuteAsync(
        DeploymentWorkItem item,
        Func<DeploymentPhaseUpdate, Task> reportProgress,
        CancellationToken cancellationToken)
    {
        string? downloadPath = null;

        try
        {
            if (!OperatingSystem.IsWindows())
                return Fail("unsupported_platform", "Software deployment requires Windows.");

            if (string.IsNullOrWhiteSpace(item.DownloadUrl))
                return Fail("download_url_missing", "The server did not provide a package download URL.");

            var prerequisites = CheckPrerequisites(item);
            if (prerequisites.Count > 0)
                return Fail("prerequisite_unmet", "Prerequisites not met: " + string.Join("; ", prerequisites));

            var workDir = ResolveWorkDirectory();
            Directory.CreateDirectory(workDir);
            downloadPath = Path.Combine(
                workDir,
                $"pkg-{item.JobId:N}-{item.AttemptNumber}{ExtensionFor(item.PackageFormat)}");

            await reportProgress(new DeploymentPhaseUpdate
            {
                State = "downloading", Progress = 20, Message = "Downloading package"
            });

            var (downloaded, hash, size) = await DownloadAsync(item, downloadPath, cancellationToken);
            if (!downloaded)
                return Fail("download_failed", "Package download failed.");

            if (size != item.FileSizeBytes)
            {
                return Fail("size_mismatch",
                    $"Package size {size} does not match approved size {item.FileSizeBytes}.");
            }

            if (!string.Equals(hash, item.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return Fail("hash_mismatch",
                    "Package SHA-256 does not match the approved hash. Installation aborted.");
            }

            await reportProgress(new DeploymentPhaseUpdate
            {
                State = "validating", Progress = 40, Message = "Package hash verified"
            });

            if (_options.RequirePackageSignature || !string.IsNullOrWhiteSpace(item.SignatureSubject))
            {
                var signature = await VerifySignatureAsync(downloadPath, cancellationToken);
                if (!signature.Valid)
                    return Fail("signature_invalid", "Signature verification failed: " + signature.Detail);

                if (!string.IsNullOrWhiteSpace(item.SignatureSubject)
                    && (string.IsNullOrWhiteSpace(signature.Subject)
                        || !signature.Subject.Contains(item.SignatureSubject, StringComparison.OrdinalIgnoreCase)))
                {
                    return Fail("signature_subject_mismatch",
                        "Package signature subject does not match the approved publisher.");
                }

                await reportProgress(new DeploymentPhaseUpdate
                {
                    State = "validating", Progress = 45, Message = "Signature verified: " + signature.Subject
                });
            }

            await reportProgress(new DeploymentPhaseUpdate
            {
                State = "installing", Progress = 60, Message = $"Running {item.Operation}"
            });

            var installExit = await RunInstallerAsync(item, downloadPath, cancellationToken);
            var output = installExit.Output;
            var rebootRequired = item.RequiresReboot
                                 || installExit.ExitCode is 3010 or 1641
                                 || LooksLikeRebootRequired(output);

            if (installExit.TimedOut)
            {
                return new DeploymentExecutionResult
                {
                    State = "failed",
                    ExitCode = installExit.ExitCode,
                    Output = output,
                    Error = "Installer timed out and was terminated.",
                    FailureClass = "timeout"
                };
            }

            if (installExit.ExitCode is not (0 or 3010 or 1641))
            {
                return new DeploymentExecutionResult
                {
                    State = "failed",
                    ExitCode = installExit.ExitCode,
                    Output = output,
                    Error = $"Installer exited with code {installExit.ExitCode}.",
                    FailureClass = "installer_exit_code"
                };
            }

            await reportProgress(new DeploymentPhaseUpdate
            {
                State = "verifying", Progress = 85, Message = "Verifying installation state"
            });

            var detection = EvaluateDetection(item, uninstall: item.Operation == "uninstall");
            var verificationOutput = output + Environment.NewLine + "[verification] " + detection.Detail;

            if (!detection.Verified)
            {
                return new DeploymentExecutionResult
                {
                    State = "failed",
                    ExitCode = installExit.ExitCode,
                    Output = verificationOutput,
                    Error = "Post-installation verification failed: " + detection.Detail,
                    FailureClass = "verification_failed",
                    RebootRequired = rebootRequired
                };
            }

            return new DeploymentExecutionResult
            {
                State = rebootRequired ? "reboot_required" : "succeeded",
                ExitCode = installExit.ExitCode,
                Output = verificationOutput,
                Error = null,
                RebootRequired = rebootRequired,
                FailureClass = string.Empty
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Deployment {JobId} failed unexpectedly", item.JobId);
            return Fail("unexpected_error", ex.Message);
        }
        finally
        {
            if (downloadPath is not null)
            {
                try
                {
                    if (File.Exists(downloadPath)) File.Delete(downloadPath);
                }
                catch
                {
                    // best effort cleanup
                }
            }
        }
    }

    private static DeploymentExecutionResult Fail(string failureClass, string error) => new()
    {
        State = "failed",
        Error = error,
        FailureClass = failureClass,
        Output = "[failure] " + failureClass + ": " + error
    };

    private string ResolveWorkDirectory()
    {
        if (!string.IsNullOrWhiteSpace(_options.DeploymentWorkingDirectory))
            return _options.DeploymentWorkingDirectory;

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "ScriptRunnerAgent",
            "packages");
    }

    private static string ExtensionFor(string format) =>
        format.ToLowerInvariant() switch
        {
            "msi" => ".msi",
            "exe" => ".exe",
            _ => ".bin"
        };

    private async Task<(bool Success, string Hash, long Size)> DownloadAsync(
        DeploymentWorkItem item,
        string destination,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, item.DownloadUrl);
            using var response = await DownloadClient.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Package download returned HTTP {Status}", (int)response.StatusCode);
                return (false, string.Empty, 0);
            }

            var length = response.Content.Headers.ContentLength;
            var limit = Math.Min(_options.MaxPackageDownloadBytes, 4L * 1024 * 1024 * 1024);
            if (length.HasValue && length.Value > limit)
            {
                _logger.LogWarning("Package download exceeds the configured limit");
                return (false, string.Empty, 0);
            }

            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None);
            using var sha = SHA256.Create();

            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
            {
                total += read;
                if (total > limit)
                {
                    return (false, string.Empty, total);
                }
                sha.TransformBlock(buffer, 0, read, null, 0);
                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);

            return (true, Convert.ToHexString(sha.Hash!).ToLowerInvariant(), total);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Package download failed");
            return (false, string.Empty, 0);
        }
    }

    private async Task<(bool Valid, string? Subject, string Detail)> VerifySignatureAsync(
        string path,
        CancellationToken cancellationToken)
    {
        // Single-quoted PowerShell literal: escape embedded quotes, never
        // interpolate arbitrary text unescaped.
        var escaped = path.Replace("'", "''", StringComparison.Ordinal);
        var script = "$s = Get-AuthenticodeSignature -LiteralPath '" + escaped + "'; " +
                     "$o = [ordered]@{ status = $s.Status.ToString(); " +
                     "subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }; " +
                     "message = $s.StatusMessage }; $o | ConvertTo-Json -Compress";

        var result = await _executionEngine.ExecuteScriptAsync(script, 60, cancellationToken);
        if (result.IsTimedOut)
            return (false, null, "Signature check timed out");

        try
        {
            using var doc = JsonDocument.Parse(result.Stdout.Trim());
            var status = doc.RootElement.TryGetProperty("status", out var s) ? s.GetString() : null;
            var subject = doc.RootElement.TryGetProperty("subject", out var sub) ? sub.GetString() : null;
            var message = doc.RootElement.TryGetProperty("message", out var m) ? m.GetString() : null;

            if (!string.Equals(status, "Valid", StringComparison.OrdinalIgnoreCase))
                return (false, subject, $"{status}: {message}");

            return (true, subject, "Valid");
        }
        catch (Exception ex)
        {
            return (false, null, "Signature response could not be parsed: " + ex.Message);
        }
    }

    private async Task<(int ExitCode, string Output, bool TimedOut)> RunInstallerAsync(
        DeploymentWorkItem item,
        string packagePath,
        CancellationToken cancellationToken)
    {
        var operation = item.Operation.ToLowerInvariant();
        var format = item.PackageFormat.ToLowerInvariant();

        ProcessStartInfo startInfo;
        if (format == "msi")
        {
            var productCode = FindMsiProductCode(item);
            if (operation == "uninstall" && string.IsNullOrWhiteSpace(productCode))
            {
                return (-1, "[uninstall] MSI product code could not be determined; uninstall not attempted.",
                    false);
            }

            var args = new StringBuilder();
            switch (operation)
            {
                case "uninstall":
                    args.Append("/x ").Append(Quote(productCode!));
                    break;
                case "repair":
                    args.Append("/f ").Append(Quote(productCode!));
                    break;
                default:
                    args.Append("/i ").Append(Quote(packagePath));
                    break;
            }

            if (operation is not ("uninstall" or "repair"))
            {
                args.Append(' ').Append(NormalizeMsiArgs(item.InstallArgs ?? "/qn /norestart"));
            }
            else if (operation == "uninstall")
            {
                args.Append(' ').Append(NormalizeMsiArgs(item.UninstallArgs ?? "/qn /norestart"));
            }
            else
            {
                args.Append(' ').Append(NormalizeMsiArgs(item.RepairArgs ?? item.InstallArgs ?? "/qn /norestart"));
            }

            startInfo = new ProcessStartInfo("msiexec.exe", args.ToString())
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(packagePath) ?? Path.GetTempPath()
            };
        }
        else if (format == "exe")
        {
            if (operation == "uninstall" && string.IsNullOrWhiteSpace(item.UninstallArgs))
            {
                return (-1,
                    "[uninstall] This EXE package defines no uninstall behaviour; automatic removal is unavailable.",
                    false);
            }
            if (operation == "repair" && string.IsNullOrWhiteSpace(item.RepairArgs))
            {
                return (-1,
                    "[repair] This EXE package defines no repair behaviour; repair is unavailable.", false);
            }

            var args = operation switch
            {
                "uninstall" => item.UninstallArgs!,
                "repair" => item.RepairArgs!,
                _ => item.InstallArgs ?? string.Empty
            };

            startInfo = new ProcessStartInfo(packagePath, args)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(packagePath) ?? Path.GetTempPath()
            };
        }
        else
        {
            return (-1, "[unsupported] No reliable handler exists for package format '" + format + "'.", false);
        }

        return await RunProcessAsync(startInfo, Math.Clamp(item.TimeoutSeconds, 30, 3600), cancellationToken);
    }

    private static string NormalizeMsiArgs(string args) =>
        args.Contains("/qn", StringComparison.OrdinalIgnoreCase)
        || args.Contains("/quiet", StringComparison.OrdinalIgnoreCase)
            ? args
            : "/qn /norestart " + args;

    private static async Task<(int ExitCode, string Output, bool TimedOut)> RunProcessAsync(
        ProcessStartInfo startInfo,
        int timeoutSeconds,
        CancellationToken cancellationToken)
    {
        var output = new StringBuilder();
        const int maxOutput = 65536;

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        void Append(string? line)
        {
            if (string.IsNullOrEmpty(line)) return;
            lock (output)
            {
                if (output.Length >= maxOutput) return;
                var remaining = maxOutput - output.Length;
                output.AppendLine(line.Length <= remaining ? line : line[..remaining]);
            }
        }

        process.OutputDataReceived += (_, e) => Append(e.Data);
        process.ErrorDataReceived += (_, e) => Append(e.Data);

        if (!process.Start())
            return (-1, "[start] Installer process could not be started.", false);

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            if (cancellationToken.IsCancellationRequested) throw;

            try { process.Kill(entireProcessTree: true); } catch { }
            try { await process.WaitForExitAsync(CancellationToken.None); } catch { }
            return (-1, output.ToString() + Environment.NewLine + "[timeout] Installer exceeded its time limit.",
                true);
        }

        // Flush asynchronous output handlers before returning the text.
        try { process.WaitForExit(); } catch { }

        return (process.ExitCode, output.ToString(), false);
    }

    private static string Quote(string value) =>
        value.StartsWith('"') && value.EndsWith('"') ? value : "\"" + value + "\"";

    private static bool LooksLikeRebootRequired(string output)
    {
        if (string.IsNullOrEmpty(output)) return false;
        return output.Contains("reboot required", StringComparison.OrdinalIgnoreCase)
               || output.Contains("restart required", StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------
    // Detection rules
    // ------------------------------------------------------------------

    private static (bool Verified, string Detail) EvaluateDetection(
        DeploymentWorkItem item,
        bool uninstall)
    {
        var rules = item.DetectionRules;
        if (rules.ValueKind != JsonValueKind.Object
            || !rules.TryGetProperty("type", out var typeProp))
        {
            return (false,
                "No detection rule is configured for this package; the operation completed but installation state could not be verified.");
        }

        var type = typeProp.GetString()?.ToLowerInvariant();
        bool detected;
        string detail;

        switch (type)
        {
            case "msi_product_code":
            {
                var code = rules.TryGetProperty("value", out var v) ? v.GetString() : null;
                detected = !string.IsNullOrWhiteSpace(code) && IsMsiProductInstalled(code!);
                detail = $"MSI product {code} {(detected ? "present" : "absent")}";
                break;
            }
            case "file_exists":
            {
                var path = rules.TryGetProperty("path", out var p) ? p.GetString() : null;
                detected = !string.IsNullOrWhiteSpace(path) && File.Exists(path);
                detail = $"File {path} {(detected ? "present" : "absent")}";
                break;
            }
            case "file_version":
            {
                var path = rules.TryGetProperty("path", out var p) ? p.GetString() : null;
                var min = rules.TryGetProperty("min_version", out var mv) ? mv.GetString() : null;
                detected = false;
                detail = $"File {path} not found or unreadable";
                if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
                {
                    try
                    {
                        var info = FileVersionInfo.GetVersionInfo(path);
                        detected = Version.TryParse(info.FileVersion, out var actual)
                                   && Version.TryParse(min, out var required)
                                   && actual >= required;
                        detail = $"File {path} version {info.FileVersion} (required >= {min})";
                    }
                    catch (Exception ex)
                    {
                        detail = $"File version check failed: {ex.Message}";
                    }
                }
                break;
            }
            case "registry_value":
            {
                var path = rules.TryGetProperty("path", out var p) ? p.GetString() : null;
                var name = rules.TryGetProperty("name", out var n) ? n.GetString() : null;
                var expected = rules.TryGetProperty("value", out var v) ? v.GetString() : null;
                detected = false;
                detail = $"Registry {path}\\{name} not found";
                if (!string.IsNullOrWhiteSpace(path) && TryReadRegistry(path!, name, out var actual))
                {
                    detected = expected is null
                        || string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
                    detail = $"Registry {path}\\{name} = {actual}";
                }
                break;
            }
            case "service_exists":
            {
                var name = rules.TryGetProperty("name", out var n) ? n.GetString() : null;
                detected = false;
                detail = $"Service {name} not installed";
                if (!string.IsNullOrWhiteSpace(name))
                {
                    try
                    {
                        using var key = Registry.LocalMachine.OpenSubKey(
                            @"SYSTEM\CurrentControlSet\Services\" + name);
                        detected = key is not null;
                    }
                    catch { }
                    detail = $"Service {name} {(detected ? "installed" : "not installed")}";
                }
                break;
            }
            case "process_running":
            {
                var name = rules.TryGetProperty("name", out var n) ? n.GetString() : null;
                detected = false;
                detail = $"Process {name} not running";
                if (!string.IsNullOrWhiteSpace(name))
                {
                    var processes = Process.GetProcessesByName(
                        name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name);
                    detected = processes.Length > 0;
                    foreach (var process in processes) process.Dispose();
                    detail = $"Process {name} {(detected ? "running" : "not running")}";
                }
                break;
            }
            default:
                return (false,
                    $"Unsupported detection rule '{type}'; installation state could not be verified.");
        }

        return uninstall
            ? (!detected, detail + " (expected absent after uninstall)")
            : (detected, detail);
    }

    private static bool TryReadRegistry(string path, string? name, out string? value)
    {
        value = null;
        try
        {
            var index = path.IndexOf('\\');
            if (index <= 0) return false;
            var root = path[..index].ToUpperInvariant();
            var subKey = path[(index + 1)..];
            var hive = root switch
            {
                "HKLM" or "HKEY_LOCAL_MACHINE" => RegistryHive.LocalMachine,
                "HKCU" or "HKEY_CURRENT_USER" => RegistryHive.CurrentUser,
                _ => RegistryHive.LocalMachine
            };
            if (subKey.Contains("..", StringComparison.Ordinal)) return false;

            using var baseKey = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
            using var key = baseKey.OpenSubKey(subKey);
            if (key is null) return false;
            var raw = name is null ? key.GetValue(null) : key.GetValue(name);
            value = raw?.ToString();
            return raw is not null;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsMsiProductInstalled(string productCode)
    {
        foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                foreach (var basePath in new[]
                         {
                             @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                             @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
                         })
                {
                    try
                    {
                        using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                        using var uninstall = baseKey.OpenSubKey(basePath);
                        using var key = uninstall?.OpenSubKey(productCode);
                        if (key is not null) return true;
                    }
                    catch
                    {
                        // ignored
                    }
                }
            }
        }
        return false;
    }

    private static string? FindMsiProductCode(DeploymentWorkItem item)
    {
        if (item.DetectionRules.ValueKind == JsonValueKind.Object
            && item.DetectionRules.TryGetProperty("type", out var type)
            && string.Equals(type.GetString(), "msi_product_code", StringComparison.OrdinalIgnoreCase)
            && item.DetectionRules.TryGetProperty("value", out var value))
        {
            return value.GetString();
        }

        // Fall back to locating the installed product by display name.
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            foreach (var basePath in new[]
                     {
                         @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                         @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
                     })
            {
                try
                {
                    using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                    using var uninstall = baseKey.OpenSubKey(basePath);
                    if (uninstall is null) continue;

                    foreach (var subName in uninstall.GetSubKeyNames())
                    {
                        if (!subName.StartsWith('{')) continue;
                        using var key = uninstall.OpenSubKey(subName);
                        var displayName = key?.GetValue("DisplayName") as string;
                        if (string.Equals(displayName, item.PackageName, StringComparison.OrdinalIgnoreCase))
                        {
                            return subName;
                        }
                    }
                }
                catch
                {
                    // ignored
                }
            }
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Prerequisites
    // ------------------------------------------------------------------

    private static List<string> CheckPrerequisites(DeploymentWorkItem item)
    {
        var failures = new List<string>();
        var prerequisites = item.Prerequisites;
        if (prerequisites.ValueKind != JsonValueKind.Array) return failures;

        foreach (var requirement in prerequisites.EnumerateArray())
        {
            if (requirement.ValueKind != JsonValueKind.Object) continue;
            var type = requirement.TryGetProperty("type", out var t) ? t.GetString()?.ToLowerInvariant() : null;

            switch (type)
            {
                case "os_build_min":
                {
                    var minBuild = requirement.TryGetProperty("value", out var v)
                        ? int.TryParse(v.GetString() ?? v.ToString(), out var parsed) ? parsed : 0
                        : 0;
                    var actual = GetOsBuildNumber();
                    if (actual is null || actual < minBuild)
                        failures.Add($"Windows build {actual?.ToString() ?? "unknown"} is below required build {minBuild}");
                    break;
                }
                case "installed_software":
                {
                    var name = requirement.TryGetProperty("name", out var n) ? n.GetString() : null;
                    if (string.IsNullOrWhiteSpace(name) || !IsSoftwareInstalled(name!))
                        failures.Add($"Required software '{name}' is not installed");
                    break;
                }
                case "file_exists":
                {
                    var path = requirement.TryGetProperty("path", out var p) ? p.GetString() : null;
                    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                        failures.Add($"Required file '{path}' is missing");
                    break;
                }
                case "registry_value":
                {
                    var path = requirement.TryGetProperty("path", out var p) ? p.GetString() : null;
                    var name = requirement.TryGetProperty("name", out var n) ? n.GetString() : null;
                    if (string.IsNullOrWhiteSpace(path) || !TryReadRegistry(path!, name, out _))
                        failures.Add($"Required registry value '{path}\\{name}' is missing");
                    break;
                }
                case "service_exists":
                {
                    var name = requirement.TryGetProperty("name", out var n) ? n.GetString() : null;
                    var exists = false;
                    try
                    {
                        using var key = Registry.LocalMachine.OpenSubKey(
                            @"SYSTEM\CurrentControlSet\Services\" + name);
                        exists = key is not null;
                    }
                    catch { }
                    if (!exists) failures.Add($"Required service '{name}' is not installed");
                    break;
                }
                default:
                    failures.Add($"Unsupported prerequisite type '{type}'");
                    break;
            }
        }

        return failures;
    }

    private static int? GetOsBuildNumber()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var build = key?.GetValue("CurrentBuildNumber")?.ToString();
            return int.TryParse(build, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
                ? parsed
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool IsSoftwareInstalled(string name)
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            foreach (var basePath in new[]
                     {
                         @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                         @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
                     })
            {
                try
                {
                    using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                    using var uninstall = baseKey.OpenSubKey(basePath);
                    if (uninstall is null) continue;
                    foreach (var subName in uninstall.GetSubKeyNames())
                    {
                        using var key = uninstall.OpenSubKey(subName);
                        var displayName = key?.GetValue("DisplayName") as string;
                        if (displayName is not null
                            && displayName.Contains(name, StringComparison.OrdinalIgnoreCase))
                        {
                            return true;
                        }
                    }
                }
                catch
                {
                    // ignored
                }
            }
        }
        return false;
    }
}
