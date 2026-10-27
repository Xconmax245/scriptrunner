using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;
using Xunit;

namespace ScriptRunnerAgent.Tests;

/// <summary>
/// These tests start a real PowerShell process on the test host (Windows) and
/// exercise the persistent-session protocol used by the remote terminal.
/// </summary>
public class PowerShellTerminalSessionTests : IAsyncLifetime
{
    private readonly string _workDir = Path.Combine(Path.GetTempPath(), "sr-terminal-tests-" + Guid.NewGuid().ToString("N"));
    private readonly ConcurrentQueue<TerminalOutputChunk> _chunks = new();
    private PowerShellTerminalSession _session = null!;
    private AgentOptions _options = null!;

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(_workDir);

        _options = new AgentOptions
        {
            WorkingDirectory = _workDir,
            MaxTerminalCommandOutputChars = 262144,
            TerminalCommandTimeoutSeconds = 60
        };

        _session = new PowerShellTerminalSession(
            _options,
            NullLogger.Instance,
            chunk => _chunks.Enqueue(chunk));

        return _session.StartAsync(CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        await _session.DisposeAsync();
        try { Directory.Delete(_workDir, recursive: true); } catch { }
    }

    private string DrainStdout()
    {
        var text = string.Concat(_chunks
            .Where(c => c.Stream == "stdout")
            .Select(c => c.Content));
        _chunks.Clear();
        return text;
    }

    [Fact]
    public async Task StartAsync_ProvidesResponsivePersistentProcess()
    {
        Assert.True(_session.IsRunning);
        Assert.False(string.IsNullOrEmpty(_session.PowerShellPath));
        Assert.Equal(IntPtr.Zero, _session.MainWindowHandle);

        var outcome = await _session.ExecuteAsync("Write-Output 'ready'", CancellationToken.None);
        Assert.True(outcome.ExitOk);
        Assert.Contains("ready", DrainStdout());
    }

    [Fact]
    public async Task ExecuteAsync_PreservesVariablesAcrossCommands()
    {
        var first = await _session.ExecuteAsync("$terminalProbe = 41", CancellationToken.None);
        Assert.True(first.ExitOk);

        var second = await _session.ExecuteAsync("Write-Output ($terminalProbe + 1)", CancellationToken.None);
        Assert.True(second.ExitOk);
        Assert.Contains("42", DrainStdout());
    }

    [Fact]
    public async Task ExecuteAsync_PreservesWorkingDirectoryAcrossCommands()
    {
        var target = Path.GetTempPath().TrimEnd('\\');
        var cd = await _session.ExecuteAsync($"Set-Location '{target}'", CancellationToken.None);
        Assert.True(cd.ExitOk);

        var pwd = await _session.ExecuteAsync("Write-Output (Get-Location).Path", CancellationToken.None);
        Assert.True(pwd.ExitOk);
        Assert.Contains(target, DrainStdout(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ExecuteAsync_PreservesFunctionsAndModuleState()
    {
        var define = await _session.ExecuteAsync("function Get-ProbeName { 'probe-ok' }", CancellationToken.None);
        Assert.True(define.ExitOk);

        var call = await _session.ExecuteAsync("Write-Output (Get-ProbeName)", CancellationToken.None);
        Assert.True(call.ExitOk);
        Assert.Contains("probe-ok", DrainStdout());
    }

    [Fact]
    public async Task ExecuteAsync_StreamsOutputBeforeCompletion()
    {
        var arrivals = new ConcurrentQueue<(DateTimeOffset At, string Content)>();
        await using var session = new PowerShellTerminalSession(
            _options,
            NullLogger.Instance,
            chunk =>
            {
                if (chunk.Stream == "stdout") arrivals.Enqueue((DateTimeOffset.UtcNow, chunk.Content));
            });

        await session.StartAsync(CancellationToken.None);

        var startedAt = DateTimeOffset.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        var outcome = await session.ExecuteAsync(
            "1..4 | ForEach-Object { Write-Output ('tick ' + $_); Start-Sleep -Milliseconds 700 }",
            CancellationToken.None);
        stopwatch.Stop();
        var completedAt = DateTimeOffset.UtcNow;

        Assert.True(outcome.ExitOk);
        Assert.True(stopwatch.Elapsed.TotalMilliseconds >= 2400,
            $"command should take about 2.8s, took {stopwatch.Elapsed.TotalMilliseconds:N0}ms");

        var firstTick = arrivals.FirstOrDefault(a => a.Content.Contains("tick 1"));
        Assert.True(firstTick.At != default, "no stdout chunk containing 'tick 1' was observed");

        // Live streaming: the first output chunk must arrive well before the
        // command finishes, not batched at completion.
        Assert.True(firstTick.At < completedAt.AddMilliseconds(-700),
            $"first chunk arrived at +{(firstTick.At - startedAt).TotalMilliseconds:N0}ms of " +
            $"{(completedAt - startedAt).TotalMilliseconds:N0}ms");
    }

    [Fact]
    public async Task ExecuteAsync_CapturesStderrSeparately()
    {
        var outcome = await _session.ExecuteAsync(
            "[Console]::Error.WriteLine('stderr-probe')",
            CancellationToken.None);

        Assert.True(outcome.ExitOk);
        Assert.Contains(_chunks, c => c.Stream == "stderr" && c.Content.Contains("stderr-probe"));
    }

    [Fact]
    public async Task ExecuteAsync_ReportsFailureExitStatus()
    {
        var outcome = await _session.ExecuteAsync("throw 'terminal-test-failure'", CancellationToken.None);

        Assert.False(outcome.ExitOk);
        Assert.False(outcome.SessionLost);
        // PowerShell renders terminating errors on stderr when stdout is redirected.
        Assert.Contains(_chunks, c => c.Content.Contains("terminal-test-failure"));
    }

    [Fact]
    public async Task ExecuteAsync_TruncatesLargeOutputAndKeepsSessionAlive()
    {
        _options.MaxTerminalCommandOutputChars = 500;

        var outcome = await _session.ExecuteAsync(
            "1..2000 | ForEach-Object { Write-Output ('x' * 20) }",
            CancellationToken.None);

        Assert.True(outcome.ExitOk);
        Assert.True(outcome.Truncated);
        Assert.Contains(_chunks, c => c.Stream == "system" && c.Content.Contains("output truncated"));

        var after = await _session.ExecuteAsync("Write-Output 'still-alive'", CancellationToken.None);
        Assert.True(after.ExitOk);
        Assert.Contains("still-alive", DrainStdout());
    }

    [Theory]
    [InlineData("Read-Host 'Enter a value'")]
    [InlineData("Get-Credential")]
    [InlineData("[Console]::ReadLine()")]
    [InlineData("notepad.exe")]
    [InlineData("Out-GridView")]
    public void DetectUnsupportedCommand_RejectsInteractiveInput(string command)
    {
        var reason = PowerShellTerminalSession.DetectUnsupportedCommand(command);
        Assert.NotNull(reason);
        Assert.Contains("noninteractive", reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("hostname")]
    [InlineData("Get-Service | Select-Object -First 3")]
    [InlineData("$x = 1; $x + 1")]
    public void DetectUnsupportedCommand_AllowsNormalCommands(string command)
    {
        Assert.Null(PowerShellTerminalSession.DetectUnsupportedCommand(command));
    }

    [Fact]
    public async Task ExecuteAsync_TimesOutAndResetsWedgedSession()
    {
        var options = new AgentOptions
        {
            WorkingDirectory = _workDir,
            TerminalCommandTimeoutSeconds = 3
        };

        await using var session = new PowerShellTerminalSession(
            options, NullLogger.Instance, _ => { });

        await session.StartAsync(CancellationToken.None);

        var outcome = await session.ExecuteAsync("Start-Sleep -Seconds 30", CancellationToken.None);

        Assert.True(outcome.TimedOut);
        Assert.Contains("reset", outcome.Error, StringComparison.OrdinalIgnoreCase);
        Assert.False(session.IsRunning);
    }
}
