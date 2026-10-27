using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Services;
using Xunit;

namespace ScriptRunnerAgent.Tests;

public class JobExecutionEngineTests
{
    private readonly JobExecutionEngine _engine;

    public JobExecutionEngineTests()
    {
        var options = Options.Create(new AgentOptions
        {
            MaxStdoutBytes = 1024,
            MaxStderrBytes = 512
        });

        _engine = new JobExecutionEngine(options, NullLogger<JobExecutionEngine>.Instance);
    }

    [Fact]
    public async Task ExecuteScriptAsync_ValidScript_ReturnsStdoutAndZeroExitCode()
    {
        string script = "Write-Output 'SCRIPT_EXECUTION_SUCCESSFUL'";
        var result = await _engine.ExecuteScriptAsync(script, 10, CancellationToken.None);

        Assert.Equal(0, result.ExitCode);
        Assert.True(result.IsSuccess);
        Assert.False(result.IsTimedOut);
        Assert.Contains("SCRIPT_EXECUTION_SUCCESSFUL", result.Stdout);
        Assert.Empty(result.Stderr);
    }

    [Fact]
    public async Task ExecuteScriptAsync_FailingScript_ReturnsStderrAndNonZeroExitCode()
    {
        string script = @"[Console]::Error.WriteLine('SIMULATED_FAILURE_OUTPUT'); exit 42";
        var result = await _engine.ExecuteScriptAsync(script, 10, CancellationToken.None);

        Assert.Equal(42, result.ExitCode);
        Assert.False(result.IsSuccess);
        Assert.False(result.IsTimedOut);
        Assert.Contains("SIMULATED_FAILURE_OUTPUT", result.Stderr);
    }

    [Fact]
    public async Task ExecuteScriptAsync_LongRunningScript_TimesOutAndKillsProcess()
    {
        // Script attempts to sleep for 30 seconds; timeout set to 2 seconds
        string script = "Start-Sleep -Seconds 30; Write-Output 'SHOULD_NOT_REACH'";
        var result = await _engine.ExecuteScriptAsync(script, 2, CancellationToken.None);

        Assert.True(result.IsTimedOut);
        Assert.False(result.IsSuccess);
        Assert.Equal(-1, result.ExitCode);
        Assert.DoesNotContain("SHOULD_NOT_REACH", result.Stdout);
        Assert.NotNull(result.ErrorSummary);
        Assert.Contains("timed out", result.ErrorSummary, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ExecuteScriptAsync_SensitiveData_IsRedactedFromOutput()
    {
        string script = @"Write-Output 'user: admin, password: SuperSecretPassword123!'; Write-Output 'api_key=sbp_9876543210abcdef1234567890abcdef'";
        var result = await _engine.ExecuteScriptAsync(script, 10, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.DoesNotContain("SuperSecretPassword123!", result.Stdout);
        Assert.DoesNotContain("sbp_9876543210abcdef1234567890abcdef", result.Stdout);
        Assert.Contains("[REDACTED_SECRET]", result.Stdout);
    }

    [Fact]
    public async Task ExecuteScriptAsync_ExceedsOutputLimit_TruncatesGracefully()
    {
        // Generate output larger than 1024 bytes limit
        string script = "1..100 | ForEach-Object { Write-Output ('LINE_' + $_ + '_PADDING_DATA_FOR_BUFFER_TESTING_OVERFLOW') }";
        var result = await _engine.ExecuteScriptAsync(script, 10, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.True(result.StdoutTruncated);
        Assert.True(result.Stdout.Length <= 1024);
    }
}
