using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Deployment;
using ScriptRunnerAgent.Inventory;
using ScriptRunnerAgent.Monitoring;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;
using Xunit;

namespace ScriptRunnerAgent.Tests;

/// <summary>
/// These are integration-style tests that run against the real Windows host.
/// They verify that collection returns actual values and that failure paths are
/// reported honestly (never as healthy defaults).
/// </summary>
public class RmmAgentTests : IDisposable
{
    private readonly string _stateDir;
    private readonly AgentOptions _options;
    private readonly IOptions<AgentOptions> _optionsAccessor;

    public RmmAgentTests()
    {
        _stateDir = Path.Combine(Path.GetTempPath(), "ScriptRunnerRmmTests_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_stateDir);
        _options = new AgentOptions
        {
            LocalStateDirectory = _stateDir,
            RmmStateDirectory = _stateDir,
            DeploymentWorkingDirectory = Path.Combine(_stateDir, "packages"),
            MinimumEventLevel = 3,
            MaxEventsPerScan = 25,
            EventLogs = new[] { "Application", "System" }
        };
        _optionsAccessor = Options.Create(_options);
    }

    [Fact]
    public async Task HardwareCollector_ReturnsRealInventoryOrExplicitWarnings()
    {
        if (!OperatingSystem.IsWindows()) return;

        var collector = new HardwareInventoryCollector(
            NullLogger<HardwareInventoryCollector>.Instance);
        var hardware = await collector.CollectAsync(CancellationToken.None);

        Assert.NotNull(hardware);
        Assert.NotNull(hardware.Warnings);
        // RAM comes from Win32_ComputerSystem/PhysicalMemory and must be real.
        Assert.True(hardware.RamBytes is > 0, "Installed RAM should be collected on Windows");
        Assert.NotNull(hardware.Cpu);
        Assert.False(string.IsNullOrWhiteSpace(hardware.Cpu!.Model));
        Assert.True(hardware.Cpu.LogicalProcessors is > 0);
        Assert.True(hardware.Storage.Count > 0, "At least one physical disk should be inventoried");
    }

    [Fact]
    public async Task OperatingSystemCollector_ReportsBuildUptimeAndRebootState()
    {
        if (!OperatingSystem.IsWindows()) return;

        var collector = new OperatingSystemInventoryCollector();
        var os = await collector.CollectAsync(CancellationToken.None);

        Assert.NotNull(os);
        Assert.False(string.IsNullOrWhiteSpace(os.Build));
        Assert.False(string.IsNullOrWhiteSpace(os.Architecture));
        Assert.NotNull(os.UptimeSeconds);
        Assert.True(os.UptimeSeconds > 0);
        Assert.NotNull(os.LastBootTime);
        // PendingReboot must be an explicit value, not silently omitted.
        Assert.NotNull(os.PendingReboot);
        Assert.NotEmpty(os.Disks);
        Assert.All(os.Disks, volume =>
        {
            Assert.NotNull(volume.Name);
            Assert.True(volume.TotalBytes > 0);
            Assert.InRange(volume.UsedPercent ?? -1, 0, 100);
        });
    }

    [Fact]
    public async Task SoftwareCollector_ReturnsUniqueApplicationsWithStableKeys()
    {
        if (!OperatingSystem.IsWindows()) return;

        var collector = new SoftwareInventoryCollector();
        var scan = await collector.CollectAsync(CancellationToken.None);

        Assert.NotNull(scan);
        Assert.NotEmpty(scan.Applications);

        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in scan.Applications)
        {
            Assert.False(string.IsNullOrWhiteSpace(app.Name));
            Assert.False(string.IsNullOrWhiteSpace(app.ProductKey));
            Assert.True(app.ProductKey.Length <= 400);
            Assert.True(keys.Add(app.ProductKey), "Duplicate product key: " + app.ProductKey);
        }
    }

    [Fact]
    public async Task NetworkCollector_ReturnsPhysicalInterfaces()
    {
        if (!OperatingSystem.IsWindows()) return;

        var collector = new NetworkInventoryCollector();
        var network = await collector.CollectAsync(CancellationToken.None);

        Assert.NotNull(network);
        Assert.NotEmpty(network.Interfaces);
        Assert.All(network.Interfaces, nic =>
        {
            Assert.False(string.IsNullOrWhiteSpace(nic.Name));
            Assert.NotNull(nic.Ipv4);
        });
    }

    [Fact]
    public async Task MetricsCollector_ProducesBoundedRealSamples()
    {
        var collector = new SystemMetricsCollector();
        var first = await collector.SampleAsync(CancellationToken.None);

        Assert.NotEmpty(first);
        var cpu = first.SingleOrDefault(s => s.Metric == "cpu.percent");
        Assert.NotNull(cpu);
        Assert.InRange(cpu!.Value, 0, 100);
        Assert.False(double.IsNaN(cpu.Value) || double.IsInfinity(cpu.Value));

        var memory = first.SingleOrDefault(s => s.Metric == "memory.percent");
        Assert.NotNull(memory);
        Assert.InRange(memory!.Value, 0, 100);

        var total = first.SingleOrDefault(s => s.Metric == "memory.total_bytes");
        Assert.NotNull(total);
        Assert.True(total!.Value > 0);

        Assert.Contains(first, s => s.Metric == "disk.used_percent");
        Assert.Contains(first, s => s.Metric == "process.count");

        // First sample has no network rate baseline; a second sample should.
        await Task.Delay(1100);
        var second = await collector.SampleAsync(CancellationToken.None);
        Assert.Contains(second, s => s.Metric == "network.rx_bytes_total");

        foreach (var sample in first.Concat(second))
        {
            Assert.False(string.IsNullOrWhiteSpace(sample.Metric));
            Assert.False(double.IsNaN(sample.Value));
            Assert.Matches("^[a-z0-9_.-]{1,80}$", sample.Metric);
        }
    }

    [Fact]
    public async Task EventLogScanner_ReadsBoundedEntriesAndDeduplicatesAcrossScans()
    {
        if (!OperatingSystem.IsWindows()) return;

        var store = new RmmStateStore(_optionsAccessor);
        var scanner = new EventLogScanner(
            _optionsAccessor, store, NullLogger<EventLogScanner>.Instance);

        var first = await scanner.ScanAsync(false, 256 * 1024, CancellationToken.None);
        Assert.NotNull(first);
        // The cap applies per log (Application + System).
        Assert.True(first.Count <= 50);
        Assert.All(first.GroupBy(e => e.LogName),
            group => Assert.True(group.Count() <= 25));
        Assert.All(first, entry =>
        {
            Assert.StartsWith(entry.LogName + "|", entry.DedupeKey);
            Assert.True((entry.Message ?? string.Empty).Length <= 4000);
        });

        var second = await scanner.ScanAsync(false, 256 * 1024, CancellationToken.None);
        Assert.NotNull(second);

        // The incremental bookmark prevents re-reading the same records.
        var firstKeys = first.Select(e => e.DedupeKey).ToHashSet();
        Assert.DoesNotContain(second, e => firstKeys.Contains(e.DedupeKey));

        // Security log is not read unless both local and policy opt-in are set.
        var noSecurity = await scanner.ScanAsync(false, 256 * 1024, CancellationToken.None);
        Assert.DoesNotContain(noSecurity, e => e.LogName.Equals("Security", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task MonitorRunner_FileAndProcessChecksReportRealState()
    {
        if (!OperatingSystem.IsWindows()) return;

        var runner = BuildMonitorRunner(out _);
        var tempFile = Path.Combine(_stateDir, "monitor-probe.txt");
        await File.WriteAllTextAsync(tempFile, "probe");

        var fileMonitor = Monitor("file", new { path = tempFile, condition = "exists" });
        var fileOutcome = await runner.ExecuteAsync(fileMonitor, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("ok", fileOutcome.Status);

        var missingMonitor = Monitor("file", new { path = tempFile + ".missing", condition = "exists" });
        var missingOutcome = await runner.ExecuteAsync(missingMonitor, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("warning", missingOutcome.Status);

        var processName = Path.GetFileNameWithoutExtension(Environment.ProcessPath) ?? "testhost";
        var processMonitor = Monitor("process", new { name = processName, mode = "present" });
        var processOutcome = await runner.ExecuteAsync(processMonitor, new AgentRmmSettings(), CancellationToken.None);
        Assert.NotEqual("error", processOutcome.Status);

        var absentMonitor = Monitor("process", new
        {
            name = "definitely-not-running-" + Guid.NewGuid().ToString("N"),
            mode = "present"
        });
        var absentOutcome = await runner.ExecuteAsync(absentMonitor, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("warning", absentOutcome.Status);
        Assert.False((bool)absentOutcome.Details["crash_confirmed"]!);
    }

    [Fact]
    public async Task MonitorRunner_ServiceAndRegistryChecksUseRealWindowsState()
    {
        if (!OperatingSystem.IsWindows()) return;

        var runner = BuildMonitorRunner(out _);

        var service = System.ServiceProcess.ServiceController.GetServices()
            .OrderBy(s => s.ServiceName)
            .FirstOrDefault();
        Assert.NotNull(service);
        try
        {
            var expected = service!.Status == System.ServiceProcess.ServiceControllerStatus.Running
                ? "running" : "stopped";
            var serviceMonitor = Monitor("service", new
            {
                service_name = service.ServiceName,
                expected_status = expected
            });
            var serviceOutcome = await runner.ExecuteAsync(
                serviceMonitor, new AgentRmmSettings(), CancellationToken.None);
            Assert.Equal("ok", serviceOutcome.Status);
            Assert.Equal(service.ServiceName, serviceOutcome.Details["service"]);
        }
        finally
        {
            service!.Dispose();
        }

        using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
            @"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        var productName = key?.GetValue("ProductName") as string;
        Assert.False(string.IsNullOrWhiteSpace(productName));

        var registryMonitor = Monitor("registry", new
        {
            path = @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            value_name = "ProductName",
            condition = "equals",
            expected = productName
        });
        var registryOutcome = await runner.ExecuteAsync(
            registryMonitor, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("ok", registryOutcome.Status);
    }

    [Fact]
    public async Task MonitorRunner_PowerShellMonitorIsGatedByPolicy()
    {
        if (!OperatingSystem.IsWindows()) return;

        var runner = BuildMonitorRunner(out _);
        var monitor = Monitor("powershell", new { script = "exit 0", expected_exit_code = 0 });

        var denied = await runner.ExecuteAsync(
            monitor, new AgentRmmSettings { AllowCustomPowershellMonitors = false }, CancellationToken.None);
        Assert.Equal("unknown", denied.Status);
        Assert.Contains("disabled", denied.Message, StringComparison.OrdinalIgnoreCase);

        var allowed = await runner.ExecuteAsync(
            monitor, new AgentRmmSettings { AllowCustomPowershellMonitors = true }, CancellationToken.None);
        Assert.Equal("ok", allowed.Status);
    }

    [Fact]
    public async Task MonitorRunner_ConnectivityChecksReportReachability()
    {
        if (!OperatingSystem.IsWindows()) return;

        var runner = BuildMonitorRunner(out _);
        var ping = Monitor("ping", new { target = "127.0.0.1", timeout_ms = 1000 });
        var pingOutcome = await runner.ExecuteAsync(ping, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("ok", pingOutcome.Status);

        // Reserve a port, close it, then verify a TCP check reports failure.
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();

        var tcp = Monitor("tcp", new { host = "127.0.0.1", port, timeout_ms = 1000 });
        var tcpOutcome = await runner.ExecuteAsync(tcp, new AgentRmmSettings(), CancellationToken.None);
        Assert.Equal("warning", tcpOutcome.Status);
    }

    [Fact]
    public async Task DeploymentExecutor_RejectsHashMismatchWithoutRunningInstaller()
    {
        var payload = Encoding.UTF8.GetBytes("not-a-real-installer");
        var port = await StartSingleRequestServer(payload);

        var executor = new SoftwareDeploymentExecutor(
            new JobExecutionEngine(_optionsAccessor, NullLogger<JobExecutionEngine>.Instance),
            _optionsAccessor,
            NullLogger<SoftwareDeploymentExecutor>.Instance);

        var phases = new List<string>();
        var item = new DeploymentWorkItem
        {
            JobId = Guid.NewGuid(),
            Operation = "install",
            PackageName = "Test package",
            PackageFormat = "msi",
            Version = "1.0.0",
            Sha256 = new string('0', 64),
            FileSizeBytes = payload.Length,
            DownloadUrl = $"http://127.0.0.1:{port}/package.msi",
            TimeoutSeconds = 60,
            DetectionRules = Json("""{"type":"file_exists","path":"C:\\definitely-missing"}"""),
            Prerequisites = Json("[]")
        };

        var result = await executor.ExecuteAsync(item, update =>
        {
            phases.Add(update.State);
            return Task.CompletedTask;
        }, CancellationToken.None);

        Assert.Equal("failed", result.State);
        Assert.Equal("hash_mismatch", result.FailureClass);
        Assert.Contains("downloading", phases);
        Assert.Contains("SHA-256", result.Error);
    }

    [Fact]
    public async Task DeploymentExecutor_BlocksUnmetPrerequisitesBeforeDownload()
    {
        var executor = new SoftwareDeploymentExecutor(
            new JobExecutionEngine(_optionsAccessor, NullLogger<JobExecutionEngine>.Instance),
            _optionsAccessor,
            NullLogger<SoftwareDeploymentExecutor>.Instance);

        var item = new DeploymentWorkItem
        {
            JobId = Guid.NewGuid(),
            Operation = "install",
            PackageName = "Blocked package",
            PackageFormat = "msi",
            Sha256 = new string('a', 64),
            FileSizeBytes = 10,
            DownloadUrl = "http://127.0.0.1:1/unreachable.msi",
            DetectionRules = Json("""{"type":"file_exists","path":"C:\\missing"}"""),
            Prerequisites = Json("""[{"type":"os_build_min","value":"999999"}]""")
        };

        var result = await executor.ExecuteAsync(
            item, _ => Task.CompletedTask, CancellationToken.None);

        Assert.Equal("failed", result.State);
        Assert.Equal("prerequisite_unmet", result.FailureClass);
        Assert.Contains("build", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DeploymentExecutor_ReportsUnavailableWithoutDownloadUrl()
    {
        var executor = new SoftwareDeploymentExecutor(
            new JobExecutionEngine(_optionsAccessor, NullLogger<JobExecutionEngine>.Instance),
            _optionsAccessor,
            NullLogger<SoftwareDeploymentExecutor>.Instance);

        var item = new DeploymentWorkItem
        {
            JobId = Guid.NewGuid(),
            PackageFormat = "msi",
            Sha256 = new string('a', 64),
            FileSizeBytes = 10
        };

        var result = await executor.ExecuteAsync(
            item, _ => Task.CompletedTask, CancellationToken.None);

        Assert.Equal("failed", result.State);
        Assert.Equal("download_url_missing", result.FailureClass);
    }

    [Fact]
    public async Task RmmStateStore_PersistsBookmarksAndRecoveryAttempts()
    {
        var store = new RmmStateStore(_optionsAccessor);
        var state = await store.LoadAsync(CancellationToken.None);
        state.EventBookmarks["System"] = 1234;
        state.RecoveryAttempts["service:spooler"] = new List<DateTimeOffset> { DateTimeOffset.UtcNow };
        await store.SaveAsync(state, CancellationToken.None);

        var reloaded = await store.LoadAsync(CancellationToken.None);
        Assert.Equal(1234, reloaded.EventBookmarks["System"]);
        Assert.Single(reloaded.RecoveryAttempts["service:spooler"]);
    }

    // ------------------------------------------------------------------

    private MonitorRunner BuildMonitorRunner(out InventoryCache cache)
    {
        cache = new InventoryCache();
        return new MonitorRunner(
            new SystemMetricsCollector(),
            new HardwareInventoryCollector(NullLogger<HardwareInventoryCollector>.Instance),
            new OperatingSystemInventoryCollector(),
            cache,
            new JobExecutionEngine(_optionsAccessor, NullLogger<JobExecutionEngine>.Instance),
            new RmmStateStore(_optionsAccessor),
            _optionsAccessor,
            NullLogger<MonitorRunner>.Instance);
    }

    private static MonitorDefinition Monitor(string kind, object config) => new()
    {
        Id = Guid.NewGuid(),
        Name = "test-" + kind,
        Kind = kind,
        Config = Json(JsonSerializer.Serialize(config)),
        IntervalSeconds = 60,
        TimeoutSeconds = 30,
        Severity = "warning",
        RecoveryAction = Json("{}")
    };

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static async Task<int> StartSingleRequestServer(byte[] payload)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        _ = Task.Run(async () =>
        {
            try
            {
                using var client = await listener.AcceptTcpClientAsync();
                await using var stream = client.GetStream();
                var buffer = new byte[4096];
                await stream.ReadAsync(buffer);

                var header = Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 200 OK\r\nContent-Length: {payload.Length}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(header);
                await stream.WriteAsync(payload);
                await stream.FlushAsync();
            }
            catch
            {
                // test server
            }
            finally
            {
                listener.Stop();
            }
        });

        return port;
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_stateDir)) Directory.Delete(_stateDir, recursive: true);
        }
        catch { }
    }
}
