using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Deployment;
using ScriptRunnerAgent.Inventory;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Monitoring;
using ScriptRunnerAgent.Services;

namespace ScriptRunnerAgent.Worker;

/// <summary>
/// Background RMM worker.
///
/// Collection is scheduled from server-provided intervals with a small jitter so
/// a large fleet does not poll in lockstep. Every collection is bounded and
/// independent: a failed inventory scan does not stop metric collection, and a
/// failed upload is retried without duplicating side effects.
///
/// Deployments run on a separate loop and are claimed atomically server-side;
/// the agent never re-executes a job that reached a terminal state.
/// </summary>
public sealed class RmmWorkerService : BackgroundService
{
    private readonly ISupabaseApiClient _api;
    private readonly EnrollmentService _enrollment;
    private readonly AgentRuntimeState _runtime;
    private readonly HardwareInventoryCollector _hardware;
    private readonly OperatingSystemInventoryCollector _os;
    private readonly NetworkInventoryCollector _network;
    private readonly SoftwareInventoryCollector _software;
    private readonly SystemMetricsCollector _metrics;
    private readonly EventLogScanner _events;
    private readonly MonitorRunner _monitors;
    private readonly SoftwareDeploymentExecutor _deployments;
    private readonly InventoryCache _cache;
    private readonly AgentOptions _options;
    private readonly ILogger<RmmWorkerService> _logger;

    private readonly object _configGate = new();
    private AgentRmmConfig _config = new();
    private DateTimeOffset _configFetchedAt = DateTimeOffset.MinValue;

    private readonly Dictionary<Guid, DateTimeOffset> _monitorNextRun = new();
    private DateTimeOffset _nextMetrics = DateTimeOffset.MinValue;
    private DateTimeOffset _nextInventory = DateTimeOffset.MinValue;
    private DateTimeOffset _nextSoftware = DateTimeOffset.MinValue;
    private DateTimeOffset _nextEvents = DateTimeOffset.MinValue;

    private readonly ConcurrentQueue<MetricSample> _pendingMetrics = new();
    private const int MaxPendingMetrics = 2000;

    private int _monitorInFlight;

    public RmmWorkerService(
        ISupabaseApiClient api,
        EnrollmentService enrollment,
        AgentRuntimeState runtime,
        HardwareInventoryCollector hardware,
        OperatingSystemInventoryCollector os,
        NetworkInventoryCollector network,
        SoftwareInventoryCollector software,
        SystemMetricsCollector metrics,
        EventLogScanner events,
        MonitorRunner monitors,
        SoftwareDeploymentExecutor deployments,
        InventoryCache cache,
        IOptions<AgentOptions> options,
        ILogger<RmmWorkerService> logger)
    {
        _api = api;
        _enrollment = enrollment;
        _runtime = runtime;
        _hardware = hardware;
        _os = os;
        _network = network;
        _software = software;
        _metrics = metrics;
        _events = events;
        _monitors = monitors;
        _deployments = deployments;
        _cache = cache;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.EnableRmm)
        {
            _logger.LogInformation("RMM collection is disabled by local configuration.");
            return;
        }

        _logger.LogInformation("RMM worker starting.");

        // Give enrollment a moment to establish credentials.
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        var deploymentLoop = DeploymentLoopAsync(stoppingToken);
        try
        {
            await CollectionLoopAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // normal shutdown
        }
        finally
        {
            try { await deploymentLoop; } catch (OperationCanceledException) { }
        }

        _logger.LogInformation("RMM worker stopped.");
    }

    // ------------------------------------------------------------------
    // Collection loop
    // ------------------------------------------------------------------

    private async Task CollectionLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (_enrollment.State != AgentAuthorizationState.Authorized)
                {
                    await _enrollment.EnsureAuthorizedAsync(cancellationToken);
                    await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
                    continue;
                }

                await RefreshConfigIfDueAsync(cancellationToken);

                var now = DateTimeOffset.UtcNow;

                if (now >= _nextMetrics)
                {
                    await CollectMetricsAsync(cancellationToken);
                    _nextMetrics = Next(now, _config.Settings.MetricsIntervalSeconds, 10, 60);
                }

                if (now >= _nextInventory)
                {
                    await CollectInventoryAsync(cancellationToken);
                    _nextInventory = Next(now, _config.Settings.InventoryIntervalSeconds, 300, 3600);
                }

                if (now >= _nextSoftware)
                {
                    await CollectSoftwareAsync(cancellationToken);
                    _nextSoftware = Next(now, _config.Settings.SoftwareScanIntervalSeconds, 300, 3600);
                }

                if (now >= _nextEvents)
                {
                    await CollectEventsAsync(cancellationToken);
                    _nextEvents = Next(now, _config.Settings.EventScanIntervalSeconds, 60, 300);
                }

                await RunDueMonitorsAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "RMM collection cycle failed; retrying.");
                _runtime.RecordFailure();
            }

            await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken);
        }
    }

    private async Task RefreshConfigIfDueAsync(CancellationToken cancellationToken)
    {
        if (DateTimeOffset.UtcNow - _configFetchedAt < TimeSpan.FromMinutes(5))
        {
            return;
        }

        var config = await _api.GetAgentConfigAsync(cancellationToken);
        if (config is null) return;

        var previouslyKnown = _config.Monitors
            .Select(m => m.Id)
            .ToHashSet();

        lock (_configGate)
        {
            _config = config;
            _configFetchedAt = DateTimeOffset.UtcNow;
        }

        _runtime.RecordSuccess();

        // Schedule new monitors shortly after discovery, not all at once.
        var random = new Random();
        foreach (var monitor in config.Monitors)
        {
            if (!previouslyKnown.Contains(monitor.Id))
            {
                _monitorNextRun[monitor.Id] = DateTimeOffset.UtcNow.AddSeconds(random.Next(1, 30));
            }
        }

        // Forget monitors that were removed or disabled.
        foreach (var stale in _monitorNextRun.Keys
                     .Where(id => config.Monitors.All(m => m.Id != id))
                     .ToList())
        {
            _monitorNextRun.Remove(stale);
        }

        _logger.LogInformation(
            "RMM policy refreshed: {MonitorCount} monitor(s), metrics every {MetricsInterval}s.",
            config.Monitors.Count, config.Settings.MetricsIntervalSeconds);
    }

    private async Task CollectMetricsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var samples = await _metrics.SampleAsync(cancellationToken);

            // Retry samples that could not be delivered previously.
            var batch = new List<MetricSample>();
            while (_pendingMetrics.TryDequeue(out var pending) && batch.Count < 200)
            {
                batch.Add(pending);
            }
            batch.AddRange(samples);

            if (batch.Count == 0) return;

            var sent = await _api.SendMetricsAsync(batch, cancellationToken);
            if (!sent)
            {
                foreach (var sample in batch)
                {
                    if (_pendingMetrics.Count >= MaxPendingMetrics) break;
                    _pendingMetrics.Enqueue(sample);
                }
            }
            else
            {
                _runtime.RecordSuccess();
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Metric collection failed: {Message}", ex.Message);
        }
    }

    private async Task CollectInventoryAsync(CancellationToken cancellationToken)
    {
        try
        {
            var hardwareTask = _hardware.CollectAsync(cancellationToken);
            var osTask = _os.CollectAsync(cancellationToken);
            var networkTask = _network.CollectAsync(cancellationToken);
            await Task.WhenAll(hardwareTask, osTask, networkTask);

            var hardware = hardwareTask.Result;
            var os = osTask.Result;
            var network = networkTask.Result;

            _cache.Set(hardware, os);

            var quality = hardware.Warnings
                .Concat(os.Warnings)
                .Concat(network.Warnings)
                .Distinct()
                .Take(50)
                .ToList();

            var sent = await _api.SendInventoryAsync(
                hardware, os, network, quality, DateTimeOffset.UtcNow, cancellationToken);

            if (sent)
            {
                _runtime.RecordSuccess();
                _logger.LogInformation(
                    "Inventory uploaded: {Cpu}, {RamBytes} bytes RAM, {Volumes} volume(s).",
                    hardware.Cpu?.Model ?? "unknown CPU",
                    hardware.RamBytes,
                    os.Disks.Count);
            }
            else
            {
                // Retry sooner than the full inventory interval.
                _nextInventory = DateTimeOffset.UtcNow.AddMinutes(2);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Inventory collection failed.");
            _nextInventory = DateTimeOffset.UtcNow.AddMinutes(2);
        }
    }

    private async Task CollectSoftwareAsync(CancellationToken cancellationToken)
    {
        try
        {
            var scan = await _software.CollectAsync(cancellationToken);
            var sent = await _api.SendSoftwareInventoryAsync(
                scan.Applications, scan.CollectedAt, cancellationToken);

            if (sent)
            {
                _runtime.RecordSuccess();
                _logger.LogInformation("Software inventory uploaded: {Count} application(s).",
                    scan.Applications.Count);
            }
            else
            {
                _nextSoftware = DateTimeOffset.UtcNow.AddMinutes(2);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Software inventory failed.");
            _nextSoftware = DateTimeOffset.UtcNow.AddMinutes(2);
        }
    }

    private async Task CollectEventsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var settings = _config.Settings;
            var events = await _events.ScanAsync(
                settings.AllowSecurityEventCollection,
                Math.Clamp(settings.MaxEventBytesPerScan, 4096, 16777216),
                cancellationToken);

            if (events.Count == 0) return;

            var sent = await _api.SendEventsAsync(events, cancellationToken);
            if (sent)
            {
                _runtime.RecordSuccess();
                _logger.LogInformation("Uploaded {Count} Windows event(s).", events.Count);
            }
            else
            {
                _nextEvents = DateTimeOffset.UtcNow.AddMinutes(1);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Event log collection failed.");
            _nextEvents = DateTimeOffset.UtcNow.AddMinutes(1);
        }
    }

    private async Task RunDueMonitorsAsync(CancellationToken cancellationToken)
    {
        AgentRmmConfig config;
        lock (_configGate) config = _config;

        var now = DateTimeOffset.UtcNow;
        foreach (var monitor in config.Monitors)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!_monitorNextRun.TryGetValue(monitor.Id, out var due) || now < due)
            {
                continue;
            }

            // Do not allow an overloaded monitor to pile up executions.
            if (Interlocked.Exchange(ref _monitorInFlight, 1) == 1)
            {
                return;
            }

            try
            {
                var outcome = await _monitors.ExecuteAsync(monitor, config.Settings, cancellationToken);
                var observed = DateTimeOffset.UtcNow;
                await _api.ReportMonitorResultAsync(monitor.Id, outcome, observed, cancellationToken);

                if (outcome.Status != "ok")
                {
                    _logger.LogInformation(
                        "Monitor {Monitor} ({Kind}): {Status} — {Message}",
                        monitor.Name, monitor.Kind, outcome.Status, outcome.Message);
                }

                _monitorNextRun[monitor.Id] = Next(
                    DateTimeOffset.UtcNow,
                    Math.Clamp(monitor.IntervalSeconds, 15, 86400),
                    15,
                    120);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Monitor {Monitor} execution failed.", monitor.Name);
                _monitorNextRun[monitor.Id] = DateTimeOffset.UtcNow.AddMinutes(1);
            }
            finally
            {
                Interlocked.Exchange(ref _monitorInFlight, 0);
            }
        }
    }

    // ------------------------------------------------------------------
    // Deployment loop
    // ------------------------------------------------------------------

    private async Task DeploymentLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (_enrollment.State != AgentAuthorizationState.Authorized)
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
                    continue;
                }

                var item = await _api.ClaimDeploymentAsync(cancellationToken);
                if (item is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                    continue;
                }

                _logger.LogInformation(
                    "Deployment {JobId} claimed: {Operation} {Package} {Version} (attempt {Attempt}).",
                    item.JobId, item.Operation, item.PackageName, item.Version, item.AttemptNumber);

                var lastReportedState = string.Empty;
                var result = await _deployments.ExecuteAsync(item, async update =>
                {
                    lastReportedState = update.State;
                    await _api.UpdateDeploymentAsync(
                        item.JobId, update.State, update.Progress, null, null, null, null,
                        cancellationToken);
                }, cancellationToken);

                // If the executor itself failed before reporting a phase, make
                // sure the server still receives a terminal state.
                if (string.IsNullOrEmpty(lastReportedState))
                {
                    await _api.UpdateDeploymentAsync(
                        item.JobId, result.State, result.State == "succeeded" ? 100 : null,
                        result.ExitCode, result.Output, result.Error, result.RebootRequired,
                        cancellationToken);
                }
                else
                {
                    await _api.UpdateDeploymentAsync(
                        item.JobId, result.State,
                        result.State is "succeeded" or "reboot_required" ? 100 : null,
                        result.ExitCode, result.Output, result.Error, result.RebootRequired,
                        cancellationToken);
                }

                _runtime.RecordSuccess();
                _logger.LogInformation(
                    "Deployment {JobId} finished: {State}{Reboot}.",
                    item.JobId, result.State, result.RebootRequired ? " (reboot required)" : "");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Deployment loop failed; retrying.");
                _runtime.RecordFailure();
                await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken);
            }
        }
    }

    // ------------------------------------------------------------------
    // Scheduling
    // ------------------------------------------------------------------

    private static DateTimeOffset Next(DateTimeOffset now, int seconds, int minSeconds, int maxJitter)
    {
        var interval = Math.Clamp(seconds, minSeconds, 86400);
        var jitter = Random.Shared.Next(0, Math.Max(1, maxJitter));
        return now.AddSeconds(interval + jitter);
    }
}
