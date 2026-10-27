using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

public class StatePersistenceManager : IStatePersistenceManager
{
    private readonly AgentOptions _options;
    private readonly ILogger<StatePersistenceManager> _logger;
    private readonly string _stateFilePath;
    private readonly SemaphoreSlim _fileLock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    public StatePersistenceManager(
        IOptions<AgentOptions> options,
        ILogger<StatePersistenceManager> logger)
    {
        _options = options.Value;
        _logger = logger;

        string baseDir = !string.IsNullOrEmpty(_options.LocalStateDirectory)
            ? _options.LocalStateDirectory
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ScriptRunnerAgent", "state");

        Directory.CreateDirectory(baseDir);
        _stateFilePath = Path.Combine(baseDir, "active_job.json");
    }

    public async Task SaveInFlightStateAsync(LocalExecutionState state, CancellationToken cancellationToken)
    {
        await _fileLock.WaitAsync(cancellationToken);
        try
        {
            string tmpPath = _stateFilePath + ".tmp";
            string json = JsonSerializer.Serialize(state, JsonOpts);

            await File.WriteAllTextAsync(tmpPath, json, cancellationToken);
            File.Move(tmpPath, _stateFilePath, overwrite: true);

            _logger.LogDebug("Persisted in-flight execution state for job {JobId}", state.JobId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist in-flight execution state for job {JobId}", state.JobId);
        }
        finally
        {
            _fileLock.Release();
        }
    }

    public async Task<LocalExecutionState?> LoadInFlightStateAsync(CancellationToken cancellationToken)
    {
        await _fileLock.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(_stateFilePath))
            {
                return null;
            }

            string json = await File.ReadAllTextAsync(_stateFilePath, cancellationToken);
            return JsonSerializer.Deserialize<LocalExecutionState>(json, JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load in-flight state file from {Path}", _stateFilePath);
            return null;
        }
        finally
        {
            _fileLock.Release();
        }
    }

    public async Task UpdateCompletedResultAsync(ExecutionResult result, CancellationToken cancellationToken)
    {
        await _fileLock.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(_stateFilePath))
            {
                return;
            }

            string json = await File.ReadAllTextAsync(_stateFilePath, cancellationToken);
            var state = JsonSerializer.Deserialize<LocalExecutionState>(json, JsonOpts);
            if (state != null)
            {
                state.ExecutionCompleted = true;
                state.CachedResult = result;

                string tmpPath = _stateFilePath + ".tmp";
                string updatedJson = JsonSerializer.Serialize(state, JsonOpts);
                await File.WriteAllTextAsync(tmpPath, updatedJson, cancellationToken);
                File.Move(tmpPath, _stateFilePath, overwrite: true);

                _logger.LogDebug("Cached completed execution result locally for job {JobId}", state.JobId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to update completed result in local state file");
        }
        finally
        {
            _fileLock.Release();
        }
    }

    public async Task ClearInFlightStateAsync(CancellationToken cancellationToken)
    {
        await _fileLock.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(_stateFilePath))
            {
                File.Delete(_stateFilePath);
                _logger.LogDebug("Cleared local execution state file.");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to delete local state file at {Path}", _stateFilePath);
        }
        finally
        {
            _fileLock.Release();
        }
    }
}
