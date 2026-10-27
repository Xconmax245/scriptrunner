using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Monitoring;

/// <summary>
/// Samples CPU, memory, disk and network utilisation.
///
/// CPU is derived from GetSystemTimes deltas and network rates from interface
/// counters deltas. A rate is only reported when a previous sample exists;
/// the collector never invents a measurement for the first sample.
/// </summary>
public sealed class SystemMetricsCollector
{
    private readonly Dictionary<string, (long Rx, long Tx, DateTimeOffset At)> _networkBaseline =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly object _gate = new();

    /// <summary>Returns the CPU utilisation percentage over the elapsed interval.</summary>
    public async Task<double?> GetCpuPercentAsync(
        TimeSpan window,
        CancellationToken cancellationToken)
    {
        ulong idle0, kernel0, user0;
        lock (_gate) ReadCpuTimes(out idle0, out kernel0, out user0);

        var delay = window < TimeSpan.FromMilliseconds(250)
            ? TimeSpan.FromMilliseconds(250)
            : window;
        await Task.Delay(delay, cancellationToken);

        lock (_gate)
        {
            ReadCpuTimes(out var idle1, out var kernel1, out var user1);

            var idle = idle1 - idle0;
            var kernel = kernel1 - kernel0;
            var user = user1 - user0;
            var total = kernel + user;
            if (total == 0) return null;

            var busy = total > idle ? total - idle : 0;
            return Math.Round(100.0 * busy / total, 2);
        }
    }

    public async Task<List<MetricSample>> SampleAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var samples = new List<MetricSample>();
        var cpu = await GetCpuPercentAsync(TimeSpan.FromMilliseconds(750), cancellationToken);
        if (cpu.HasValue) samples.Add(Sample("cpu.percent", cpu.Value, now));

        CollectMemory(samples, now);
        CollectDisks(samples, now);
        CollectProcesses(samples, now);
        CollectNetwork(samples, now);

        return samples;
    }

    public void CollectMemory(List<MetricSample> samples, DateTimeOffset? at = null)
    {
        var stamp = at ?? DateTimeOffset.UtcNow;
        try
        {
            var status = new MemoryStatusEx();
            if (!GlobalMemoryStatusEx(status)) return;

            var total = (long)status.ullTotalPhys;
            var available = (long)status.ullAvailPhys;
            var used = Math.Max(0, total - available);

            samples.Add(Sample("memory.total_bytes", total, stamp));
            samples.Add(Sample("memory.available_bytes", available, stamp));
            samples.Add(Sample("memory.used_bytes", used, stamp));
            samples.Add(Sample("memory.percent", total > 0 ? Math.Round(100.0 * used / total, 2) : 0, stamp));
        }
        catch (Exception ex)
        {
            Debug.WriteLine("Memory sampling failed: " + ex.Message);
        }
    }

    public double? GetMemoryPercent()
    {
        try
        {
            var status = new MemoryStatusEx();
            return GlobalMemoryStatusEx(status) ? status.dwMemoryLoad : null;
        }
        catch
        {
            return null;
        }
    }

    public List<VolumeInventory> GetVolumes() => GetVolumes(out _);

    public List<VolumeInventory> GetVolumes(out List<string> warnings)
    {
        warnings = new List<string>();
        var volumes = new List<VolumeInventory>();
        try
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                    var used = drive.TotalSize - drive.TotalFreeSpace;
                    volumes.Add(new VolumeInventory
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
                catch (Exception ex)
                {
                    warnings.Add("A volume could not be read: " + ex.Message);
                }
            }
        }
        catch (Exception ex)
        {
            warnings.Add("Disk sampling failed: " + ex.Message);
        }
        return volumes;
    }

    private void CollectDisks(List<MetricSample> samples, DateTimeOffset now)
    {
        var volumes = GetVolumes(out var warnings);
        foreach (var volume in volumes)
        {
            var dimensions = new Dictionary<string, object?> { ["volume"] = volume.Name };
            if (volume.UsedPercent.HasValue)
            {
                samples.Add(Sample("disk.used_percent", volume.UsedPercent.Value, now, dimensions));
            }
            if (volume.FreeBytes.HasValue)
            {
                samples.Add(Sample("disk.free_bytes", volume.FreeBytes.Value, now, dimensions));
            }
            if (volume.TotalBytes.HasValue)
            {
                samples.Add(Sample("disk.total_bytes", volume.TotalBytes.Value, now, dimensions));
            }
        }

        if (warnings.Count > 0)
        {
            samples.Add(Sample("disk.collection_error", 1, now,
                new Dictionary<string, object?> { ["detail"] = string.Join("; ", warnings.Take(3)) }));
        }
    }

    private static void CollectProcesses(List<MetricSample> samples, DateTimeOffset now)
    {
        try
        {
            var processes = Process.GetProcesses();
            try
            {
                samples.Add(Sample("process.count", processes.Length, now));
            }
            finally
            {
                foreach (var process in processes)
                {
                    process.Dispose();
                }
            }
        }
        catch
        {
            // Process enumeration can fail under restricted accounts; the
            // absence of the sample is preferable to a fabricated value.
        }
    }

    private void CollectNetwork(List<MetricSample> samples, DateTimeOffset now)
    {
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                try
                {
                    var stats = nic.GetIPStatistics();
                    var rx = stats.BytesReceived;
                    var tx = stats.BytesSent;
                    var dims = new Dictionary<string, object?> { ["interface"] = nic.Name };

                    samples.Add(Sample("network.rx_bytes_total", rx, now, dims));
                    samples.Add(Sample("network.tx_bytes_total", tx, now, dims));

                    if (_networkBaseline.TryGetValue(nic.Name, out var prev))
                    {
                        var seconds = Math.Max(0.001, (now - prev.At).TotalSeconds);
                        var rxDelta = rx - prev.Rx;
                        var txDelta = tx - prev.Tx;
                        if (rxDelta < 0) rxDelta = 0; // counter reset / adapter restart
                        if (txDelta < 0) txDelta = 0;
                        samples.Add(Sample("network.rx_bytes_per_sec", Math.Round(rxDelta / seconds, 2), now, dims));
                        samples.Add(Sample("network.tx_bytes_per_sec", Math.Round(txDelta / seconds, 2), now, dims));
                    }

                    _networkBaseline[nic.Name] = (rx, tx, now);
                }
                catch
                {
                    // ignored
                }
            }
        }
        catch
        {
            // ignored: network counters are best-effort
        }
    }

    private static MetricSample Sample(
        string metric,
        double value,
        DateTimeOffset at,
        Dictionary<string, object?>? dimensions = null) => new()
    {
        Metric = metric,
        Value = value,
        Dimensions = dimensions,
        CollectedAt = at.ToString("o")
    };

    private static void ReadCpuTimes(out ulong idle, out ulong kernel, out ulong user)
    {
        if (!GetSystemTimes(out var idleTime, out var kernelTime, out var userTime))
        {
            idle = kernel = user = 0;
            return;
        }

        idle = FileTimeToUInt64(idleTime);
        kernel = FileTimeToUInt64(kernelTime);
        user = FileTimeToUInt64(userTime);

    }

    private static ulong FileTimeToUInt64(FileTime fileTime) =>
        ((ulong)fileTime.HighDateTime << 32) | fileTime.LowDateTime;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(
        out FileTime idleTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [StructLayout(LayoutKind.Sequential)]
    private sealed class MemoryStatusEx
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MemoryStatusEx));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatusEx lpBuffer);
}
