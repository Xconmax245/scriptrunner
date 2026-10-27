using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;

namespace ScriptRunnerAgent.Worker;

/// <summary>
/// Owns remote terminal sessions for this device.
///
/// The worker polls the gateway for a session an administrator opened, starts one
/// persistent PowerShell process for that session, long-polls for commands and
/// streams stdout/stderr back in ordered batches. It never runs one PowerShell
/// process per command, so variables and the working directory persist.
/// </summary>
public sealed class TerminalWorkerService : BackgroundService
{
    private readonly ISupabaseApiClient _apiClient;
    private readonly EnrollmentService _enrollment;
    private readonly AgentOptions _options;
    private readonly ILogger<TerminalWorkerService> _logger;
    private readonly ILoggerFactory _loggerFactory;

    // Identifies this agent process. Used by the backend to detect that a session
    // outlived the agent that owned it (service restart / crash).
    private readonly string _agentInstanceId = Guid.NewGuid().ToString("N");
    private readonly bool _isElevated = ExecutionContextInfo.IsElevated;
    private readonly string _accountName = ExecutionContextInfo.AccountName;

    public TerminalWorkerService(
        ISupabaseApiClient apiClient,
        EnrollmentService enrollment,
        IOptions<AgentOptions> options,
        ILogger<TerminalWorkerService> logger,
        ILoggerFactory loggerFactory)
    {
        _apiClient = apiClient;
        _enrollment = enrollment;
        _options = options.Value;
        _logger = logger;
        _loggerFactory = loggerFactory;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.EnableRemoteTerminal)
        {
            _logger.LogInformation("Remote terminal is disabled by configuration.");
            return;
        }

        _logger.LogInformation(
            "Remote terminal worker started as {Account} (elevated: {Elevated}), instance {Instance}.",
            _accountName, _isElevated, _agentInstanceId);

        int idleDelaySeconds = Math.Max(1, _options.TerminalClaimIntervalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _enrollment.EnsureAuthorizedAsync(stoppingToken))
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                    continue;
                }

                TerminalClaimResult? claim;
                try
                {
                    claim = await _apiClient.ClaimTerminalSessionAsync(_agentInstanceId, stoppingToken);
                }
                catch (DeviceNotAuthorizedException ex)
                {
                    _enrollment.MarkNotAuthorized(ex.EnrollmentStatus, ex.Message);
                    await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                    continue;
                }

                if (claim is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(idleDelaySeconds), stoppingToken);
                    continue;
                }

                await RunSessionAsync(claim, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error in the remote terminal worker");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        _logger.LogInformation("Remote terminal worker stopped.");
    }

    private async Task RunSessionAsync(TerminalClaimResult claim, CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "Terminal session {SessionId} opened for host {Host} (expires {Expires:u}).",
            claim.SessionId, claim.Hostname, claim.ExpiresAt);

        var channel = Channel.CreateUnbounded<TerminalOutputChunk>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        var session = new PowerShellTerminalSession(
            _options,
            _loggerFactory.CreateLogger<PowerShellTerminalSession>(),
            chunk => channel.Writer.TryWrite(chunk));

        string? endReason = null;
        bool endedByServer = false;

        try
        {
            await session.StartAsync(stoppingToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not start the persistent PowerShell session");
            channel.Writer.TryWrite(SystemText(
                $"Failed to start PowerShell on this device: {ex.Message}\r\n"));
            channel.Writer.TryComplete();
            await PumpOutputAsync(channel.Reader, claim.SessionId, stoppingToken);
            await _apiClient.EndTerminalSessionAsync(
                claim.SessionId, "Agent could not start PowerShell", stoppingToken);
            return;
        }

        var pumpTask = PumpOutputAsync(channel.Reader, claim.SessionId, stoppingToken);

        // Send the command names PowerShell can resolve in this session so the
        // dashboard can offer Tab completion. This is internal metadata: the UI
        // strips it from the visible output.
        try
        {
            string completionText = await session.CaptureOutputAsync(
                "Get-Command -CommandType Cmdlet,Function,Alias | Select-Object -ExpandProperty Name | Sort-Object -Unique",
                stoppingToken);

            var names = completionText
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.Length > 0 && n.Length <= 80 && n.All(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(3000)
                .ToArray();

            foreach (var slice in names.Chunk(60))
            {
                channel.Writer.TryWrite(new TerminalOutputChunk
                {
                    Stream = "system",
                    Content = "\u0001SR-COMPLETIONS\u0001" + System.Text.Json.JsonSerializer.Serialize(slice)
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug("Could not enumerate PowerShell commands for completion: {Message}", ex.Message);
        }

        channel.Writer.TryWrite(SystemText(
            $"ScriptRunner remote terminal attached to {claim.Hostname} " +
            $"({Environment.MachineName}).\r\n" +
            $"PowerShell: {session.PowerShellPath}\r\n" +
            $"Service account: {_accountName} " +
            $"({(_isElevated ? "elevated" : "standard privileges - elevated operations will be denied")}).\r\n" +
            $"Session ID: {claim.SessionId}. This session runs in a hidden, noninteractive service context; " +
            $"no window opens on the target desktop.\r\n\r\n"));

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (DateTimeOffset.UtcNow >= claim.ExpiresAt)
                {
                    endReason = "Session lifetime exceeded";
                    break;
                }

                var poll = await _apiClient.PollTerminalCommandsAsync(claim.SessionId, stoppingToken);

                if (!poll.Success)
                {
                    if (!string.IsNullOrEmpty(poll.CloseReason) &&
                        poll.SessionStatus is "revoked" or "closed" or "expired" or "invalid")
                    {
                        endedByServer = poll.SessionStatus != "invalid";
                        endReason = poll.CloseReason;
                        break;
                    }

                    // Transient transport failure: the command channel is still
                    // established server-side; reconnect the poll.
                    await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
                    continue;
                }

                if (poll.SessionEnded)
                {
                    endedByServer = true;
                    endReason = poll.CloseReason ?? $"Session {poll.SessionStatus}";
                    _logger.LogInformation("Terminal session {SessionId} ended: {Reason}",
                        claim.SessionId, endReason);
                    break;
                }

                foreach (var command in poll.Commands)
                {
                    if (stoppingToken.IsCancellationRequested) break;

                    string? rejection = PowerShellTerminalSession.DetectUnsupportedCommand(command.Command);
                    if (rejection is not null)
                    {
                        channel.Writer.TryWrite(SystemText(
                            $"\r\n[not executed] {rejection}\r\n"));
                        await _apiClient.ReportTerminalCommandResultAsync(
                            claim.SessionId, command.Sequence, false, rejection, stoppingToken);
                        continue;
                    }

                    var outcome = await ExecuteWithWatchdogAsync(
                        session, claim.SessionId, command.Command, stoppingToken);

                    if (outcome.AccessDeniedHint && !_isElevated)
                    {
                        channel.Writer.TryWrite(SystemText(
                            "\r\n[access denied] The command was denied. The ScriptRunner service account " +
                            $"({_accountName}) does not hold the required privileges. Elevated operations " +
                            "require an explicitly configured elevated service account/policy.\r\n"));
                    }

                    if (outcome.Truncated)
                    {
                        channel.Writer.TryWrite(SystemText(
                            "\r\n[output truncated] Only part of this command's output was streamed.\r\n"));
                    }

                    await _apiClient.ReportTerminalCommandResultAsync(
                        claim.SessionId, command.Sequence, outcome.ExitOk, outcome.Error, stoppingToken);

                    if (outcome.TimedOut)
                    {
                        endReason = outcome.Error ?? "Command timed out";
                        channel.Writer.TryWrite(SystemText(
                            $"\r\n[session reset] {endReason}\r\n"));
                        break;
                    }

                    if (outcome.SessionLost)
                    {
                        endReason = "PowerShell process exited; session state was lost";
                        channel.Writer.TryWrite(SystemText(
                            $"\r\n[session ended] {endReason}\r\n"));
                        break;
                    }
                }

                if (endReason is not null) break;
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            endReason = "Agent service stopping";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Terminal session {SessionId} failed", claim.SessionId);
            endReason = $"Agent error: {ex.Message}";
        }
        finally
        {
            channel.Writer.TryComplete();

            try
            {
                await pumpTask;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug("Output pump ended with error: {Message}", ex.Message);
            }
            catch (OperationCanceledException)
            {
                // Service is stopping; output already best-effort.
            }

            await session.DisposeAsync();

            if (!endedByServer)
            {
                await _apiClient.EndTerminalSessionAsync(
                    claim.SessionId,
                    endReason ?? "Session ended by agent",
                    CancellationToken.None);
            }

            _logger.LogInformation("Terminal session {SessionId} closed: {Reason}",
                claim.SessionId, endReason ?? "ended by server");
        }
    }

    /// <summary>
    /// Executes a command while watching the server-side session state, so an
    /// administrator disconnect or device revocation kills the PowerShell
    /// process instead of waiting for the command to finish on its own.
    /// </summary>
    private async Task<TerminalCommandOutcome> ExecuteWithWatchdogAsync(
        PowerShellTerminalSession session,
        Guid sessionId,
        string command,
        CancellationToken stoppingToken)
    {
        var execution = session.ExecuteAsync(command, stoppingToken);

        while (!execution.IsCompleted && !stoppingToken.IsCancellationRequested)
        {
            var finished = await Task.WhenAny(execution, Task.Delay(TimeSpan.FromSeconds(2), stoppingToken));

            if (finished == execution) break;
            if (stoppingToken.IsCancellationRequested) break;

            var state = await _apiClient.GetTerminalSessionStateAsync(sessionId, stoppingToken);
            if (state.Ended)
            {
                _logger.LogInformation(
                    "Session {SessionId} ended ({Status}: {Reason}); stopping the running command.",
                    sessionId, state.Status, state.Reason);
                await session.DisposeAsync();
                break;
            }
        }

        return await execution;
    }

    private async Task PumpOutputAsync(
        ChannelReader<TerminalOutputChunk> reader,
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        int batchChars = Math.Max(512, _options.TerminalOutputBatchChars);

        try
        {
            while (await reader.WaitToReadAsync(cancellationToken))
            {
                var batch = new List<TerminalOutputChunk>(32);
                int chars = 0;

                while (batch.Count < 100 && chars < batchChars && reader.TryRead(out var chunk))
                {
                    batch.Add(chunk);
                    chars += chunk.Content.Length;
                }

                if (batch.Count == 0) continue;

                // Brief coalescing window: keeps live latency low while batching
                // chatty commands into a single request.
                await Task.Delay(15, cancellationToken);
                while (batch.Count < 100 && chars < batchChars && reader.TryRead(out var extra))
                {
                    batch.Add(extra);
                    chars += extra.Content.Length;
                }

                try
                {
                    var ack = await _apiClient.SendTerminalOutputAsync(sessionId, batch, cancellationToken);
                    if (ack is null)
                    {
                        _logger.LogWarning("Output batch for session {SessionId} was not acknowledged", sessionId);
                    }
                    else if (ack.SessionEnded)
                    {
                        return;
                    }
                }
                catch (DeviceNotAuthorizedException ex)
                {
                    _enrollment.MarkNotAuthorized(ex.EnrollmentStatus, ex.Message);
                    return;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // Bounded, best-effort streaming: a failed batch (e.g. network
                    // loss) is dropped rather than buffered without limit.
                    _logger.LogWarning("Failed to stream terminal output: {Message}", ex.Message);
                    await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    private static TerminalOutputChunk SystemText(string text) =>
        new() { Stream = "system", Content = text.Replace("\n", "\r\n") };
}
