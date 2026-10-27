using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Win32;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Inventory;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;

namespace ScriptRunnerAgent.Monitoring;

/// <summary>
/// Executes monitor definitions sent by the server.
///
/// Security notes:
///  * PowerShell monitors run only when the organisation explicitly enables
///    them; the setting is enforced here, not merely in the UI.
///  * Service recovery is bounded by a per-service cooldown and a hard limit of
///    five actions per 24 hours, and every action is reported.
///  * Event-log and registry identifiers are validated before use in queries or
///    registry paths.
/// </summary>
public sealed class MonitorRunner
{
    private static readonly Regex ServiceNamePattern =
        new("^[A-Za-z0-9_.\\-]{1,256}$", RegexOptions.Compiled);
    private static readonly Regex ProcessNamePattern =
        new("^[A-Za-z0-9_.\\- ]{1,260}$", RegexOptions.Compiled);
    private static readonly Regex TargetPattern =
        new("^[A-Za-z0-9_.:\\-]{1,253}$", RegexOptions.Compiled);

    private readonly SystemMetricsCollector _metrics;
    private readonly HardwareInventoryCollector _hardwareCollector;
    private readonly OperatingSystemInventoryCollector _osCollector;
    private readonly InventoryCache _inventory;
    private readonly IJobExecutionEngine _executionEngine;
    private readonly RmmStateStore _stateStore;
    private readonly AgentOptions _options;
    private readonly ILogger<MonitorRunner> _logger;

    public MonitorRunner(
        SystemMetricsCollector metrics,
        HardwareInventoryCollector hardwareCollector,
        OperatingSystemInventoryCollector osCollector,
        InventoryCache inventory,
        IJobExecutionEngine executionEngine,
        RmmStateStore stateStore,
        IOptions<AgentOptions> options,
        ILogger<MonitorRunner> logger)
    {
        _metrics = metrics;
        _hardwareCollector = hardwareCollector;
        _osCollector = osCollector;
        _inventory = inventory;
        _executionEngine = executionEngine;
        _stateStore = stateStore;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<MonitorOutcome> ExecuteAsync(
        MonitorDefinition monitor,
        AgentRmmSettings settings,
        CancellationToken cancellationToken)
    {
        var started = Stopwatch.StartNew();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(monitor.TimeoutSeconds, 1, 600)));

        try
        {
            var outcome = await EvaluateAsync(monitor, settings, cts.Token);
            return new MonitorOutcome
            {
                Status = outcome.Status,
                Value = outcome.Value,
                Message = outcome.Message,
                Details = outcome.Details,
                DurationMs = (int)started.ElapsedMilliseconds,
                Error = outcome.Error,
                RecoveryPerformed = outcome.RecoveryPerformed,
                RecoveryNote = outcome.RecoveryNote
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return new MonitorOutcome
            {
                Status = "error",
                Message = $"Monitor timed out after {monitor.TimeoutSeconds}s",
                Error = "timeout",
                DurationMs = (int)started.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Monitor {Monitor} ({Kind}) failed", monitor.Name, monitor.Kind);
            return new MonitorOutcome
            {
                Status = "error",
                Message = ex.Message,
                Error = ex.GetType().Name + ": " + ex.Message,
                DurationMs = (int)started.ElapsedMilliseconds
            };
        }
    }

    private Task<MonitorOutcome> EvaluateAsync(
        MonitorDefinition monitor,
        AgentRmmSettings settings,
        CancellationToken cancellationToken)
    {
        var config = monitor.Config.ValueKind == JsonValueKind.Object
            ? monitor.Config
            : JsonDocument.Parse("{}").RootElement;

        return monitor.Kind switch
        {
            "cpu" => EvaluateCpuAsync(monitor, config, cancellationToken),
            "memory" => EvaluateMemoryAsync(monitor, config, cancellationToken),
            "disk" => EvaluateDiskAsync(monitor, config, cancellationToken),
            "process" => EvaluateProcessAsync(monitor, config, cancellationToken),
            "service" => EvaluateServiceAsync(monitor, config, settings, cancellationToken),
            "event_log" => EvaluateEventLogAsync(monitor, config, cancellationToken),
            "file" => EvaluateFileAsync(monitor, config, cancellationToken),
            "directory" => EvaluateDirectoryAsync(monitor, config, cancellationToken),
            "registry" => EvaluateRegistryAsync(monitor, config, cancellationToken),
            "powershell" => EvaluatePowerShellAsync(monitor, config, settings, cancellationToken),
            "ping" => EvaluatePingAsync(monitor, config, cancellationToken),
            "tcp" => EvaluateTcpAsync(monitor, config, cancellationToken),
            "hardware" => EvaluateHardwareAsync(monitor, config, cancellationToken),
            "os" => EvaluateOsAsync(monitor, config, cancellationToken),
            "custom_metric" => EvaluateCustomMetricAsync(monitor, config, cancellationToken),
            _ => Task.FromResult(MonitorOutcome.Unknown($"Unsupported monitor kind '{monitor.Kind}'"))
        };
    }

    // ------------------------------------------------------------------
    // Resource thresholds
    // ------------------------------------------------------------------

    private async Task<MonitorOutcome> EvaluateCpuAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var sampleMs = Math.Clamp(GetInt(config, "sample_ms") ?? 1000, 500, 5000);
        var value = await _metrics.GetCpuPercentAsync(TimeSpan.FromMilliseconds(sampleMs), cancellationToken);
        if (!value.HasValue) return MonitorOutcome.Unknown("CPU utilisation could not be sampled");

        var threshold = GetDouble(config, "threshold") ?? 85;
        var comparison = GetString(config, "comparison") ?? "gte";
        if (Breaches(value.Value, threshold, comparison))
        {
            return Breach(monitor, $"CPU at {value.Value:0.##}% (threshold {threshold}%)", value,
                new() { ["threshold"] = threshold, ["comparison"] = comparison });
        }
        return Ok($"CPU at {value.Value:0.##}%", value);
    }

    private async Task<MonitorOutcome> EvaluateMemoryAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var samples = new List<MetricSample>();
        _metrics.CollectMemory(samples);
        var metricName = GetString(config, "metric") ?? "memory.percent";
        var sample = samples.FirstOrDefault(s =>
            s.Metric.Equals(metricName, StringComparison.OrdinalIgnoreCase));
        if (sample is null) return MonitorOutcome.Unknown("Memory counters are unavailable");

        var threshold = GetDouble(config, "threshold") ?? 90;
        var comparison = GetString(config, "comparison") ?? "gte";
        if (Breaches(sample.Value, threshold, comparison))
        {
            return Breach(monitor,
                $"Memory {metricName} = {sample.Value:0.##} (threshold {threshold})", sample.Value,
                new() { ["threshold"] = threshold, ["metric"] = metricName });
        }
        return Ok($"Memory {metricName} = {sample.Value:0.##}", sample.Value);
    }

    private Task<MonitorOutcome> EvaluateDiskAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var volumes = _metrics.GetVolumes(out var warnings);
        var requested = GetString(config, "volume");
        if (!string.IsNullOrWhiteSpace(requested))
        {
            volumes = volumes
                .Where(v => string.Equals(v.Name, requested, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(v.Name?.TrimEnd('\\'), requested.TrimEnd('\\'),
                                StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        if (volumes.Count == 0)
        {
            return Task.FromResult(MonitorOutcome.Unknown(
                warnings.Count > 0
                    ? "Disk data unavailable: " + string.Join("; ", warnings.Take(2))
                    : "No matching volumes found"));
        }

        var threshold = GetDouble(config, "threshold") ?? 90;
        var comparison = GetString(config, "comparison") ?? "gte";
        var worst = volumes
            .Where(v => v.UsedPercent.HasValue)
            .OrderByDescending(v => v.UsedPercent)
            .FirstOrDefault();

        if (worst?.UsedPercent is null)
        {
            return Task.FromResult(MonitorOutcome.Unknown("Volume usage percentage is unavailable"));
        }

        var details = new Dictionary<string, object?>
        {
            ["volume"] = worst.Name,
            ["threshold"] = threshold,
            ["volumes"] = volumes.Select(v => new
            {
                name = v.Name,
                total_bytes = v.TotalBytes,
                free_bytes = v.FreeBytes,
                used_percent = v.UsedPercent
            }).ToArray()
        };

        if (Breaches(worst.UsedPercent.Value, threshold, comparison))
        {
            return Task.FromResult(Breach(monitor,
                $"Volume {worst.Name} is {worst.UsedPercent:0.##}% used (threshold {threshold}%)",
                worst.UsedPercent, details));
        }

        return Task.FromResult(Ok(
            $"Lowest free space volume {worst.Name} is {worst.UsedPercent:0.##}% used",
            worst.UsedPercent, details));
    }

    // ------------------------------------------------------------------
    // Process / service
    // ------------------------------------------------------------------

    private async Task<MonitorOutcome> EvaluateProcessAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var rawName = GetString(config, "name");
        if (string.IsNullOrWhiteSpace(rawName) || !ProcessNamePattern.IsMatch(rawName))
        {
            return MonitorOutcome.Fault("invalid_config", "A valid process name is required");
        }

        var name = rawName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? rawName[..^4]
            : rawName;
        var mode = (GetString(config, "mode") ?? "present").ToLowerInvariant();
        var memoryThresholdMb = GetDouble(config, "memory_mb");

        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName(name);
        }
        catch (Exception ex)
        {
            return MonitorOutcome.Fault("process_query_failed", ex.Message);
        }

        try
        {
            var count = processes.Length;
            var details = new Dictionary<string, object?>
            {
                ["process"] = name,
                ["mode"] = mode,
                ["count"] = count,
                ["crash_confirmed"] = false
            };

            if (mode == "absent")
            {
                if (count > 0)
                {
                    return Breach(monitor, $"Process {name} is running unexpectedly", count, details);
                }
                return Ok($"Process {name} is not running", 0, details);
            }

            if (count == 0)
            {
                // Distinguish "not running" from a confirmed crash: look for a
                // matching Windows Error Reporting event in the Application log.
                var crash = await TryFindCrashEventAsync(name, cancellationToken);
                details["crash_confirmed"] = crash.Found;
                if (crash.Found)
                {
                    details["crash_event"] = crash.Description;
                    return Breach(monitor,
                        $"Process {name} is not running; crash confirmed by Application log",
                        0, details);
                }
                return Breach(monitor, $"Process {name} is not running (crash not confirmed)", 0, details);
            }

            if (memoryThresholdMb.HasValue)
            {
                double? highest = null;
                foreach (var process in processes)
                {
                    try
                    {
                        var mb = process.WorkingSet64 / (1024.0 * 1024.0);
                        if (highest is null || mb > highest) highest = mb;
                    }
                    catch
                    {
                        // restricted process: skip this sample
                    }
                }
                details["highest_memory_mb"] = highest is null ? null : Math.Round(highest.Value, 1);
                if (highest.HasValue && highest.Value > memoryThresholdMb.Value)
                {
                    return Breach(monitor,
                        $"Process {name} uses {highest:0.#} MB (threshold {memoryThresholdMb} MB)",
                        highest, details);
                }
            }

            return Ok($"Process {name} is running ({count} instance(s))", count, details);
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    private async Task<MonitorOutcome> EvaluateServiceAsync(
        MonitorDefinition monitor,
        JsonElement config,
        AgentRmmSettings settings,
        CancellationToken cancellationToken)
    {
        var serviceName = GetString(config, "service_name");
        if (string.IsNullOrWhiteSpace(serviceName) || !ServiceNamePattern.IsMatch(serviceName))
        {
            return MonitorOutcome.Fault("invalid_config", "A valid service name is required");
        }

        var expected = (GetString(config, "expected_status") ?? "running").ToLowerInvariant();
        var expectedStartup = GetString(config, "startup_type")?.ToLowerInvariant();

        ServiceController? controller = null;
        ServiceControllerStatus status;
        try
        {
            controller = ServiceController.GetServices()
                .FirstOrDefault(s => s.ServiceName.Equals(serviceName, StringComparison.OrdinalIgnoreCase));
            if (controller is null)
            {
                return Breach(monitor, $"Service {serviceName} is not installed", 0,
                    new() { ["service"] = serviceName, ["installed"] = false });
            }
            status = controller.Status;
        }
        catch (Exception ex)
        {
            controller?.Dispose();
            return MonitorOutcome.Fault("service_query_failed", ex.Message);
        }

        try
        {
            var details = new Dictionary<string, object?>
            {
                ["service"] = serviceName,
                ["display_name"] = controller.DisplayName,
                ["state"] = status.ToString(),
                ["expected_status"] = expected
            };

            var startupType = ReadStartupType(serviceName);
            details["startup_type"] = startupType;
            details["expected_startup_type"] = expectedStartup;

            var running = status == ServiceControllerStatus.Running;
            var healthy = expected == "stopped" ? status == ServiceControllerStatus.Stopped : running;

            if (expectedStartup is not null && startupType is not null
                && !startupType.Equals(expectedStartup, StringComparison.OrdinalIgnoreCase))
            {
                healthy = false;
            }

            if (healthy)
            {
                return Ok($"Service {serviceName} is {status}", (int)status, details);
            }

            var outcome = Breach(monitor, $"Service {serviceName} is {status}; expected {expected}", (int)status, details);

            if (monitor.AutoRecovery && settings.AllowServiceRecovery && expected != "stopped")
            {
                var action = GetString(
                    monitor.RecoveryAction.ValueKind == JsonValueKind.Object ? monitor.RecoveryAction : default,
                    "action") ?? "start";
                if (action is not ("start" or "restart"))
                {
                    return new MonitorOutcome
                    {
                        Status = outcome.Status,
                        Value = outcome.Value,
                        Message = outcome.Message,
                        Details = outcome.Details,
                        DurationMs = outcome.DurationMs,
                        Error = outcome.Error,
                        RecoveryPerformed = false,
                        RecoveryNote = $"Recovery action '{action}' is not supported"
                    };
                }

                var (allowed, reason) = await AcquireRecoverySlotAsync(
                    serviceName, settings.ServiceRecoveryCooldownSeconds, cancellationToken);

                if (!allowed)
                {
                    details["recovery_skipped"] = reason;
                    return new MonitorOutcome
                    {
                        Status = outcome.Status,
                        Value = outcome.Value,
                        Message = outcome.Message,
                        Details = details,
                        DurationMs = outcome.DurationMs,
                        RecoveryPerformed = false,
                        RecoveryNote = reason
                    };
                }

                try
                {
                    if (action == "restart" && status != ServiceControllerStatus.Stopped)
                    {
                        controller.Stop();
                        controller.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(15));
                    }
                    controller.Start();
                    controller.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
                    details["recovery_action"] = action;
                    details["recovery_result"] = controller.Status.ToString();
                    return new MonitorOutcome
                    {
                        Status = outcome.Status,
                        Value = outcome.Value,
                        Message = outcome.Message + " — recovery action attempted",
                        Details = details,
                        DurationMs = outcome.DurationMs,
                        RecoveryPerformed = true,
                        RecoveryNote =
                            $"Bounded recovery ({action}) executed for service {serviceName}; state {controller.Status}"
                    };
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Service recovery failed for {Service}", serviceName);
                    details["recovery_error"] = ex.Message;
                    return new MonitorOutcome
                    {
                        Status = outcome.Status,
                        Value = outcome.Value,
                        Message = outcome.Message,
                        Details = details,
                        DurationMs = outcome.DurationMs,
                        RecoveryPerformed = true,
                        RecoveryNote = $"Recovery action for {serviceName} failed: {ex.Message}"
                    };
                }
            }

            return outcome;
        }
        finally
        {
            controller.Dispose();
        }
    }

    private static string? ReadStartupType(string serviceName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services\" + serviceName);
            return key?.GetValue("Start") switch
            {
                0 or 1 => "boot",
                2 => "automatic",
                3 => "manual",
                4 => "disabled",
                _ => null
            };
        }
        catch
        {
            return null;
        }
    }

    private async Task<(bool Allowed, string Reason)> AcquireRecoverySlotAsync(
        string serviceName,
        int cooldownSeconds,
        CancellationToken cancellationToken)
    {
        var state = await _stateStore.LoadAsync(cancellationToken);
        var key = "service:" + serviceName.ToLowerInvariant();
        if (!state.RecoveryAttempts.TryGetValue(key, out var attempts))
        {
            attempts = new List<DateTimeOffset>();
        }

        var now = DateTimeOffset.UtcNow;
        var dayAgo = now.AddHours(-24);
        attempts = attempts.Where(a => a > dayAgo).OrderBy(a => a).ToList();

        if (attempts.Count >= 5)
        {
            return (false, "Recovery limit reached (5 actions in 24 hours)");
        }

        var cooldown = TimeSpan.FromSeconds(Math.Clamp(cooldownSeconds, 60, 86400));
        if (attempts.Count > 0 && now - attempts[^1] < cooldown)
        {
            var remaining = (int)(cooldown - (now - attempts[^1])).TotalSeconds;
            return (false, $"Recovery cooling down ({remaining}s remaining)");
        }

        attempts.Add(now);
        state.RecoveryAttempts[key] = attempts;
        await _stateStore.SaveAsync(state, cancellationToken);
        return (true, "allowed");
    }

    private async Task<(bool Found, string? Description)> TryFindCrashEventAsync(
        string processName,
        CancellationToken cancellationToken)
    {
        try
        {
            var since = DateTime.UtcNow.AddMinutes(-15).ToString("o");
            var query = $"*[System[(EventID=1000 or EventID=1002) and TimeCreated[@SystemTime>='{since}']]]";
            var readerQuery = new EventLogQuery("Application", PathType.LogName, query)
            {
                TolerateQueryErrors = true
            };
            using var reader = new EventLogReader(readerQuery);
            for (var record = reader.ReadEvent(); record is not null; record = reader.ReadEvent())
            {
                using (record)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    string? description = null;
                    try { description = record.FormatDescription(); } catch { }
                    if (description is not null
                        && description.Contains(processName, StringComparison.OrdinalIgnoreCase))
                    {
                        return (true, description.Length <= 500 ? description : description[..500]);
                    }
                }
                if (cancellationToken.IsCancellationRequested) break;
            }
        }
        catch
        {
            // Crash confirmation is best-effort; absence of evidence is not
            // reported as a confirmed crash.
        }
        return (false, null);
    }

    // ------------------------------------------------------------------
    // Event / file / registry
    // ------------------------------------------------------------------

    private Task<MonitorOutcome> EvaluateEventLogAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var logName = GetString(config, "log_name") ?? "Application";
        if (!Regex.IsMatch(logName, "^[A-Za-z0-9 _\\-\\\\/]{1,128}$"))
            return Task.FromResult(MonitorOutcome.Fault("invalid_config", "Invalid event log name"));

        var eventId = GetInt(config, "event_id");
        var levelMax = GetInt(config, "level_max") ?? 5;
        var threshold = GetInt(config, "threshold") ?? 1;
        var windowMinutes = Math.Clamp(GetInt(config, "window_minutes") ?? 15, 1, 1440);
        var provider = GetString(config, "provider");
        if (provider is not null && !Regex.IsMatch(provider, "^[A-Za-z0-9 ._\\-]{1,256}$"))
            provider = null;

        var since = DateTime.UtcNow.AddMinutes(-windowMinutes).ToString("o");
        var parts = new List<string>
        {
            $"Level <= {Math.Clamp(levelMax, 1, 5)}",
            $"TimeCreated[@SystemTime>='{since}']"
        };
        if (eventId is > 0) parts.Add($"EventID={eventId}");

        var query = "*[System[" + string.Join(" and ", parts) + "]]";
        try
        {
            var eventQuery = new EventLogQuery(logName, PathType.LogName, query)
            {
                TolerateQueryErrors = true
            };
            using var reader = new EventLogReader(eventQuery);
            int count = 0;
            string? latest = null;
            for (var record = reader.ReadEvent(); record is not null && count < 50; record = reader.ReadEvent())
            {
                using (record)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (provider is not null
                        && !string.Equals(record.ProviderName, provider, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    count++;
                    try { latest = record.FormatDescription(); } catch { }
                }
            }

            var details = new Dictionary<string, object?>
            {
                ["log_name"] = logName,
                ["event_id"] = eventId,
                ["count"] = count,
                ["threshold"] = threshold,
                ["window_minutes"] = windowMinutes
            };
            if (count >= threshold)
            {
                return Task.FromResult(Breach(monitor,
                    $"{count} matching event(s) in {logName} within {windowMinutes}m" +
                    (string.IsNullOrEmpty(latest) ? "" : ": " + Truncate(latest, 300)),
                    count, details));
            }
            return Task.FromResult(Ok($"No matching events above threshold ({count})", count, details));
        }
        catch (Exception ex)
        {
            return Task.FromResult(MonitorOutcome.Fault("event_query_failed", ex.Message));
        }
    }

    private Task<MonitorOutcome> EvaluateFileAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var path = GetString(config, "path");
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1000)
            return Task.FromResult(MonitorOutcome.Fault("invalid_config", "A valid file path is required"));

        var condition = (GetString(config, "condition") ?? "exists").ToLowerInvariant();
        try
        {
            var info = new FileInfo(path);
            var exists = info.Exists;
            var details = new Dictionary<string, object?>
            {
                ["path"] = path,
                ["exists"] = exists,
                ["condition"] = condition
            };
            if (exists)
            {
                details["size_bytes"] = info.Length;
                details["last_write_utc"] = info.LastWriteTimeUtc;
            }

            var breached = condition switch
            {
                "exists" => !exists,
                "missing" => exists,
                "older_than_hours" => !exists
                    || (DateTime.UtcNow - info.LastWriteTimeUtc).TotalHours
                        > (GetDouble(config, "hours") ?? 24),
                "size_gt_bytes" => !exists || info.Length > (GetDouble(config, "bytes") ?? 0),
                _ => false
            };

            if (condition is not ("exists" or "missing" or "older_than_hours" or "size_gt_bytes"))
                return Task.FromResult(MonitorOutcome.Fault("invalid_config", "Unsupported file condition"));

            if (breached)
                return Task.FromResult(Breach(monitor, $"File condition '{condition}' failed for {path}",
                    exists ? 1 : 0, details));
            return Task.FromResult(Ok($"File condition '{condition}' satisfied", 1, details));
        }
        catch (Exception ex)
        {
            return Task.FromResult(MonitorOutcome.Fault("file_check_failed", ex.Message));
        }
    }

    private Task<MonitorOutcome> EvaluateDirectoryAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var path = GetString(config, "path");
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1000)
            return Task.FromResult(MonitorOutcome.Fault("invalid_config", "A valid directory path is required"));

        var condition = (GetString(config, "condition") ?? "exists").ToLowerInvariant();
        try
        {
            var info = new DirectoryInfo(path);
            var exists = info.Exists;
            var details = new Dictionary<string, object?>
            {
                ["path"] = path,
                ["exists"] = exists,
                ["condition"] = condition
            };

            int? count = null;
            if (exists)
            {
                try { count = info.EnumerateFiles().Take(10000).Count(); } catch { }
                details["file_count"] = count;
            }

            var breached = condition switch
            {
                "exists" => !exists,
                "missing" => exists,
                "file_count_gt" => !exists || (count ?? 0) > (GetInt(config, "threshold") ?? 0),
                _ => false
            };

            if (condition is not ("exists" or "missing" or "file_count_gt"))
                return Task.FromResult(MonitorOutcome.Fault("invalid_config", "Unsupported directory condition"));

            if (breached)
                return Task.FromResult(Breach(monitor, $"Directory condition '{condition}' failed for {path}",
                    count, details));
            return Task.FromResult(Ok($"Directory condition '{condition}' satisfied", count, details));
        }
        catch (Exception ex)
        {
            return Task.FromResult(MonitorOutcome.Fault("directory_check_failed", ex.Message));
        }
    }

    private Task<MonitorOutcome> EvaluateRegistryAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var path = GetString(config, "path");
        if (string.IsNullOrWhiteSpace(path)
            || !TryParseRegistryPath(path, out var hive, out var subKey))
        {
            return Task.FromResult(MonitorOutcome.Fault("invalid_config", "A valid registry path is required"));
        }

        var valueName = GetString(config, "value_name");
        var condition = (GetString(config, "condition") ?? "exists").ToLowerInvariant();
        var expected = GetString(config, "expected");

        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
            using var key = baseKey.OpenSubKey(subKey, writable: false);
            if (key is null)
            {
                var missingKeyBreach = condition is "exists" or "equals";
                return Task.FromResult(missingKeyBreach
                    ? Breach(monitor, $"Registry key not found: {path}", 0,
                        new() { ["path"] = path, ["exists"] = false })
                    : Ok("Registry key is absent", 0, new() { ["path"] = path, ["exists"] = false }));
            }

            var value = valueName is null ? key.GetValue(null) : key.GetValue(valueName);
            var exists = value is not null;
            var actual = value switch
            {
                string s => s,
                string[] array => string.Join(";", array),
                null => null,
                _ => Convert.ToString(value, CultureInfo.InvariantCulture)
            };

            var details = new Dictionary<string, object?>
            {
                ["path"] = path,
                ["value_name"] = valueName,
                ["exists"] = exists,
                ["actual"] = Truncate(actual, 500)
            };

            bool breached = condition switch
            {
                "exists" => !exists,
                "missing" => exists,
                "equals" => !exists || !string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase),
                "not_equals" => exists && string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase),
                _ => true
            };

            if (condition is not ("exists" or "missing" or "equals" or "not_equals"))
                return Task.FromResult(MonitorOutcome.Fault("invalid_config", "Unsupported registry condition"));

            if (breached)
                return Task.FromResult(Breach(monitor, $"Registry condition '{condition}' failed for {path}",
                    null, details));
            return Task.FromResult(Ok($"Registry condition '{condition}' satisfied", null, details));
        }
        catch (Exception ex)
        {
            return Task.FromResult(MonitorOutcome.Fault("registry_check_failed", ex.Message));
        }
    }

    private static bool TryParseRegistryPath(string path, out RegistryHive hive, out string subKey)
    {
        hive = RegistryHive.LocalMachine;
        subKey = string.Empty;

        var index = path.IndexOf('\\');
        var root = index < 0 ? path : path[..index];
        subKey = index < 0 ? string.Empty : path[(index + 1)..];

        switch (root.ToUpperInvariant())
        {
            case "HKLM":
            case "HKEY_LOCAL_MACHINE":
                hive = RegistryHive.LocalMachine;
                break;
            case "HKCU":
            case "HKEY_CURRENT_USER":
                hive = RegistryHive.CurrentUser;
                break;
            case "HKCR":
            case "HKEY_CLASSES_ROOT":
                hive = RegistryHive.ClassesRoot;
                break;
            case "HKU":
            case "HKEY_USERS":
                hive = RegistryHive.Users;
                break;
            default:
                return false;
        }

        return subKey.Length is > 0 and <= 500 && !subKey.Contains("..", StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------
    // PowerShell (explicitly gated)
    // ------------------------------------------------------------------

    private async Task<MonitorOutcome> EvaluatePowerShellAsync(
        MonitorDefinition monitor,
        JsonElement config,
        AgentRmmSettings settings,
        CancellationToken cancellationToken)
    {
        if (!settings.AllowCustomPowershellMonitors)
        {
            return MonitorOutcome.Unknown(
                "Custom PowerShell monitors are disabled by organizational policy");
        }

        var script = GetString(config, "script");
        if (string.IsNullOrWhiteSpace(script) || script.Length > 16384)
        {
            return MonitorOutcome.Fault("invalid_config", "A PowerShell script (max 16 KB) is required");
        }

        var expectedExit = GetInt(config, "expected_exit_code") ?? 0;
        var expectedOutput = GetString(config, "expected_output_contains");

        var result = await _executionEngine.ExecuteScriptAsync(
            script,
            Math.Clamp(monitor.TimeoutSeconds, 1, 600),
            cancellationToken);

        if (result.IsTimedOut)
        {
            return MonitorOutcome.Fault("monitor_timeout", "PowerShell monitor timed out");
        }

        var details = new Dictionary<string, object?>
        {
            ["exit_code"] = result.ExitCode,
            ["stdout"] = Truncate(result.Stdout, 2000),
            ["stderr"] = Truncate(result.Stderr, 1000)
        };

        var passed = result.ExitCode == expectedExit
                     && (string.IsNullOrEmpty(expectedOutput)
                         || (result.Stdout ?? string.Empty).Contains(expectedOutput, StringComparison.OrdinalIgnoreCase));

        return passed
            ? Ok("PowerShell monitor passed", result.ExitCode, details)
            : Breach(monitor,
                $"PowerShell monitor failed (exit {result.ExitCode}, expected {expectedExit})",
                result.ExitCode, details);
    }

    // ------------------------------------------------------------------
    // Connectivity
    // ------------------------------------------------------------------

    private async Task<MonitorOutcome> EvaluatePingAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var target = GetString(config, "target");
        if (string.IsNullOrWhiteSpace(target) || !TargetPattern.IsMatch(target))
            return MonitorOutcome.Fault("invalid_config", "A valid ping target is required");

        var timeout = Math.Clamp(GetInt(config, "timeout_ms") ?? 3000, 500, 30000);
        using var ping = new Ping();
        try
        {
            var reply = await ping.SendPingAsync(target, timeout);
            var details = new Dictionary<string, object?>
            {
                ["target"] = target,
                ["status"] = reply.Status.ToString(),
                ["roundtrip_ms"] = reply.RoundtripTime
            };
            if (reply.Status != IPStatus.Success)
            {
                return Breach(monitor, $"Ping to {target} failed: {reply.Status}", null, details);
            }
            return Ok($"Ping to {target} succeeded in {reply.RoundtripTime} ms",
                reply.RoundtripTime, details);
        }
        catch (Exception ex)
        {
            return MonitorOutcome.Fault("ping_failed", ex.Message);
        }
    }

    private async Task<MonitorOutcome> EvaluateTcpAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var host = GetString(config, "host");
        var port = GetInt(config, "port");
        if (string.IsNullOrWhiteSpace(host) || !TargetPattern.IsMatch(host)
            || port is null or < 1 or > 65535)
        {
            return MonitorOutcome.Fault("invalid_config", "A valid host and port are required");
        }

        var timeoutMs = Math.Clamp(GetInt(config, "timeout_ms") ?? 3000, 500, 30000);
        using var client = new TcpClient();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);

        var started = Stopwatch.StartNew();
        try
        {
            await client.ConnectAsync(host, port.Value, timeout.Token);
            var details = new Dictionary<string, object?>
            {
                ["host"] = host,
                ["port"] = port,
                ["connect_ms"] = started.ElapsedMilliseconds
            };
            return Ok($"TCP {host}:{port} reachable in {started.ElapsedMilliseconds} ms",
                started.ElapsedMilliseconds, details);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return Breach(monitor, $"TCP {host}:{port} timed out after {timeoutMs} ms", null,
                new() { ["host"] = host, ["port"] = port });
        }
        catch (Exception ex)
        {
            return Breach(monitor, $"TCP {host}:{port} failed: {ex.Message}", null,
                new() { ["host"] = host, ["port"] = port, ["error"] = ex.Message });
        }
    }

    // ------------------------------------------------------------------
    // Hardware / OS / custom metric
    // ------------------------------------------------------------------

    private async Task<MonitorOutcome> EvaluateHardwareAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var property = GetString(config, "property");
        var expected = GetString(config, "expected");
        if (string.IsNullOrWhiteSpace(property) || expected is null)
            return MonitorOutcome.Fault("invalid_config", "property and expected are required");

        if (!_inventory.IsHardwareFresh(TimeSpan.FromMinutes(60)))
        {
            var hardware = await _hardwareCollector.CollectAsync(cancellationToken);
            _inventory.Set(hardware, null);
        }

        var hw = _inventory.Hardware;
        if (hw is null) return MonitorOutcome.Unknown("Hardware inventory is unavailable");

        string? actual = property.ToLowerInvariant() switch
        {
            "manufacturer" => hw.Manufacturer,
            "model" => hw.Model,
            "serial_number" => hw.SerialNumber,
            "ram_bytes" => hw.RamBytes?.ToString(CultureInfo.InvariantCulture),
            "cpu.manufacturer" => hw.Cpu?.Manufacturer,
            "cpu.model" => hw.Cpu?.Model,
            "cpu.cores" => hw.Cpu?.Cores?.ToString(CultureInfo.InvariantCulture),
            "cpu.logical_processors" => hw.Cpu?.LogicalProcessors?.ToString(CultureInfo.InvariantCulture),
            "bios.version" => hw.Bios?.Version,
            "bios.manufacturer" => hw.Bios?.Manufacturer,
            "motherboard.model" => hw.Motherboard?.Model,
            "motherboard.serial_number" => hw.Motherboard?.SerialNumber,
            _ => null
        };

        if (actual is null) return MonitorOutcome.Unknown($"Hardware property '{property}' is unavailable");

        var comparison = GetString(config, "comparison") ?? "eq";
        var details = new Dictionary<string, object?>
        {
            ["property"] = property,
            ["actual"] = actual,
            ["expected"] = expected,
            ["comparison"] = comparison
        };

        return Compare(monitor, actual, expected, comparison, details,
            $"Hardware {property} = {actual}")
            ? Ok($"Hardware {property} matched", null, details)
            : Breach(monitor, $"Hardware {property} is {actual}, expected {comparison} {expected}", null, details);
    }

    private async Task<MonitorOutcome> EvaluateOsAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var property = GetString(config, "property");
        var expected = GetString(config, "expected");
        if (string.IsNullOrWhiteSpace(property) || expected is null)
            return MonitorOutcome.Fault("invalid_config", "property and expected are required");

        if (!_inventory.IsOsFresh(TimeSpan.FromMinutes(30)))
        {
            var os = await _osCollector.CollectAsync(cancellationToken);
            _inventory.Set(null, os);
        }

        var info = _inventory.Os;
        if (info is null) return MonitorOutcome.Unknown("OS inventory is unavailable");

        string? actual = property.ToLowerInvariant() switch
        {
            "version" => info.Version,
            "build" => info.Build,
            "edition" => info.Edition,
            "product_name" => info.ProductName,
            "pending_reboot" => info.PendingReboot?.ToString().ToLowerInvariant(),
            "uptime_seconds" => info.UptimeSeconds?.ToString(CultureInfo.InvariantCulture),
            "last_update_installed" => info.LastUpdateInstalled,
            _ => null
        };

        if (actual is null) return MonitorOutcome.Unknown($"OS property '{property}' is unavailable");

        var comparison = GetString(config, "comparison") ?? "eq";
        var details = new Dictionary<string, object?>
        {
            ["property"] = property,
            ["actual"] = actual,
            ["expected"] = expected,
            ["comparison"] = comparison
        };

        return Compare(monitor, actual, expected, comparison, details,
            $"OS {property} = {actual}")
            ? Ok($"OS {property} matched", null, details)
            : Breach(monitor, $"OS {property} is {actual}, expected {comparison} {expected}", null, details);
    }

    private async Task<MonitorOutcome> EvaluateCustomMetricAsync(
        MonitorDefinition monitor,
        JsonElement config,
        CancellationToken cancellationToken)
    {
        var metric = GetString(config, "metric") ?? "cpu.percent";
        var threshold = GetDouble(config, "threshold") ?? 80;
        var comparison = GetString(config, "comparison") ?? "gte";

        double? value = metric.ToLowerInvariant() switch
        {
            "cpu.percent" => await _metrics.GetCpuPercentAsync(TimeSpan.FromMilliseconds(750), cancellationToken),
            "memory.percent" => _metrics.GetMemoryPercent(),
            "disk.used_percent" => _metrics.GetVolumes()
                .Where(v => v.UsedPercent.HasValue)
                .OrderByDescending(v => v.UsedPercent)
                .FirstOrDefault()?.UsedPercent,
            _ => null
        };

        if (!value.HasValue)
            return MonitorOutcome.Unknown($"Metric '{metric}' is unavailable on this device");

        return Breaches(value.Value, threshold, comparison)
            ? Breach(monitor, $"{metric} = {value.Value:0.##} (threshold {threshold})", value,
                new() { ["metric"] = metric, ["threshold"] = threshold })
            : Ok($"{metric} = {value.Value:0.##}", value);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static bool Breaches(double actual, double threshold, string comparison) =>
        comparison.ToLowerInvariant() switch
        {
            "gt" => actual > threshold,
            "gte" => actual >= threshold,
            "lt" => actual < threshold,
            "lte" => actual <= threshold,
            "eq" => Math.Abs(actual - threshold) < 0.000001,
            "neq" => Math.Abs(actual - threshold) >= 0.000001,
            _ => false
        };

    private static bool Compare(
        MonitorDefinition monitor,
        string actual,
        string expected,
        string comparison,
        Dictionary<string, object?> details,
        string message)
    {
        comparison = comparison.ToLowerInvariant();
        if (double.TryParse(actual, NumberStyles.Any, CultureInfo.InvariantCulture, out var a)
            && double.TryParse(expected, NumberStyles.Any, CultureInfo.InvariantCulture, out var b)
            && comparison is "gt" or "gte" or "lt" or "lte" or "eq" or "neq")
        {
            return comparison switch
            {
                "gt" => a > b,
                "gte" => a >= b,
                "lt" => a < b,
                "lte" => a <= b,
                "eq" => Math.Abs(a - b) < 0.000001,
                "neq" => Math.Abs(a - b) >= 0.000001,
                _ => false
            };
        }

        return comparison switch
        {
            "contains" => actual.Contains(expected, StringComparison.OrdinalIgnoreCase),
            "not_contains" => !actual.Contains(expected, StringComparison.OrdinalIgnoreCase),
            "starts_with" => actual.StartsWith(expected, StringComparison.OrdinalIgnoreCase),
            "neq" => !string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase),
            _ => string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)
        };
    }

    private static MonitorOutcome Ok(
        string message,
        double? value,
        Dictionary<string, object?>? details = null) => new()
    {
        Status = "ok",
        Value = value,
        Message = message,
        Details = details ?? new()
    };

    private static MonitorOutcome Breach(
        MonitorDefinition monitor,
        string message,
        double? value,
        Dictionary<string, object?>? details = null) => new()
    {
        Status = monitor.Severity == "critical" ? "critical" : "warning",
        Value = value,
        Message = message,
        Details = details ?? new()
    };

    private static string? GetString(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(name, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static double? GetDouble(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var d)) return d;
        if (value.ValueKind == JsonValueKind.String
            && double.TryParse(value.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }
        return null;
    }

    private static int? GetInt(JsonElement element, string name)
    {
        var d = GetDouble(element, name);
        return d.HasValue ? (int)d.Value : null;
    }

    private static string? Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return value.Length <= max ? value : value[..max];
    }
}
