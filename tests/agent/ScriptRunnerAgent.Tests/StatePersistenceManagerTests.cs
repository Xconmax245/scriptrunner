using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;
using Xunit;

namespace ScriptRunnerAgent.Tests;

public class StatePersistenceManagerTests : IDisposable
{
    private readonly string _testDir;
    private readonly StatePersistenceManager _manager;

    public StatePersistenceManagerTests()
    {
        _testDir = Path.Combine(Path.GetTempPath(), "ScriptRunnerTests_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_testDir);

        var options = Options.Create(new AgentOptions
        {
            LocalStateDirectory = _testDir
        });

        _manager = new StatePersistenceManager(options, NullLogger<StatePersistenceManager>.Instance);
    }

    [Fact]
    public async Task SaveAndLoad_InFlightState_RoundTripsCorrectly()
    {
        var originalState = new LocalExecutionState
        {
            JobId = Guid.NewGuid(),
            AttemptNumber = 1,
            AgentExecutionId = "exec-test-12345",
            ScriptHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            StartedAt = DateTimeOffset.UtcNow,
            ExecutionCompleted = false
        };

        await _manager.SaveInFlightStateAsync(originalState, CancellationToken.None);
        var loaded = await _manager.LoadInFlightStateAsync(CancellationToken.None);

        Assert.NotNull(loaded);
        Assert.Equal(originalState.JobId, loaded.JobId);
        Assert.Equal(originalState.AgentExecutionId, loaded.AgentExecutionId);
        Assert.Equal(originalState.ScriptHash, loaded.ScriptHash);
        Assert.False(loaded.ExecutionCompleted);
    }

    [Fact]
    public async Task UpdateCompletedResult_CachesResultForCrashRecovery()
    {
        var originalState = new LocalExecutionState
        {
            JobId = Guid.NewGuid(),
            AttemptNumber = 1,
            AgentExecutionId = "exec-crash-test",
            StartedAt = DateTimeOffset.UtcNow,
            ExecutionCompleted = false
        };

        await _manager.SaveInFlightStateAsync(originalState, CancellationToken.None);

        var execResult = new ExecutionResult
        {
            ExitCode = 0,
            Stdout = "ALL_SYSTEMS_OPERATIONAL",
            Stderr = "",
            StartedAt = originalState.StartedAt,
            CompletedAt = DateTimeOffset.UtcNow,
            IsTimedOut = false
        };

        await _manager.UpdateCompletedResultAsync(execResult, CancellationToken.None);

        var loaded = await _manager.LoadInFlightStateAsync(CancellationToken.None);
        Assert.NotNull(loaded);
        Assert.True(loaded.ExecutionCompleted);
        Assert.NotNull(loaded.CachedResult);
        Assert.Equal("ALL_SYSTEMS_OPERATIONAL", loaded.CachedResult.Stdout);
        Assert.Equal(0, loaded.CachedResult.ExitCode);
    }

    [Fact]
    public async Task ClearInFlightState_RemovesFileCleanly()
    {
        var state = new LocalExecutionState
        {
            JobId = Guid.NewGuid(),
            AttemptNumber = 1,
            StartedAt = DateTimeOffset.UtcNow
        };

        await _manager.SaveInFlightStateAsync(state, CancellationToken.None);
        Assert.NotNull(await _manager.LoadInFlightStateAsync(CancellationToken.None));

        await _manager.ClearInFlightStateAsync(CancellationToken.None);
        Assert.Null(await _manager.LoadInFlightStateAsync(CancellationToken.None));
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_testDir))
            {
                Directory.Delete(_testDir, recursive: true);
            }
        }
        catch { }
    }
}
