using System.Text.Json;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;

namespace ScriptRunnerAgent.Monitoring;

/// <summary>
/// Local, non-secret operational state for RMM work:
///  * incremental Windows event-log bookmarks per log
///  * automated service-recovery attempt history
/// The file lives beside the job state file under ProgramData.
/// </summary>
public sealed class RmmStateStore
{
    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    public RmmStateStore(IOptions<AgentOptions> options)
    {
        var baseDir = !string.IsNullOrWhiteSpace(options.Value.RmmStateDirectory)
            ? options.Value.RmmStateDirectory
            : !string.IsNullOrWhiteSpace(options.Value.LocalStateDirectory)
                ? options.Value.LocalStateDirectory
                : Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "ScriptRunnerAgent",
                    "state");

        Directory.CreateDirectory(baseDir);
        _path = Path.Combine(baseDir, "rmm-state.json");
    }

    public async Task<RmmLocalState> LoadAsync(CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(_path)) return new RmmLocalState();
            var json = await File.ReadAllTextAsync(_path, cancellationToken);
            return JsonSerializer.Deserialize<RmmLocalState>(json, JsonOpts) ?? new RmmLocalState();
        }
        catch
        {
            // Corrupt state must not stop monitoring; start from a clean slate
            // (event dedupe keys make replay safe).
            return new RmmLocalState();
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task SaveAsync(RmmLocalState state, CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            var tmp = _path + ".tmp";
            await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(state, JsonOpts), cancellationToken);
            File.Move(tmp, _path, overwrite: true);
        }
        finally
        {
            _lock.Release();
        }
    }
}

public sealed class RmmLocalState
{
    public Dictionary<string, long> EventBookmarks { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, List<DateTimeOffset>> RecoveryAttempts { get; set; } =
        new(StringComparer.OrdinalIgnoreCase);
    public DateTimeOffset? LastEventScanAt { get; set; }
}
