using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

/// <summary>
/// A single, persistent PowerShell process attached to one remote terminal
/// session. Commands are written to the process's stdin; PowerShell keeps its
/// runspace alive, so variables, functions, modules and the current location
/// persist between commands.
///
/// Noninteractive by construction: the process is started with
/// <c>-NonInteractive</c>, <c>CreateNoWindow = true</c> and redirected stdio in
/// the service's (Session 0) context, so no console window can appear on the
/// target desktop. Commands that would block waiting for a human are rejected
/// before execution instead of hanging the session.
///
/// Command boundaries are detected with a per-command sentinel line emitted by
/// PowerShell itself, which lets the reader stream output as it is produced while
/// still knowing exactly when the command finished and whether it succeeded.
/// </summary>
public sealed class PowerShellTerminalSession : IAsyncDisposable
{
    private const string SentinelPrefix = "__SRDONE_";

    private readonly AgentOptions _options;
    private readonly ILogger _logger;
    private readonly Action<TerminalOutputChunk> _onOutput;

    private Process? _process;
    private StreamWriter? _stdin;
    private readonly StringBuilder _stdoutBuffer = new();
    private readonly object _sync = new();

    private TaskCompletionSource<CommandMarker>? _pendingCompletion;
    private string? _activeMarker;
    private StringBuilder? _captureBuffer;
    private string _recentOutputTail = string.Empty;
    private int _forwardedChars;
    private bool _truncated;
    private bool _accessDenied;
    private bool _disposed;

    public PowerShellTerminalSession(
        AgentOptions options,
        ILogger logger,
        Action<TerminalOutputChunk> onOutput,
        string? powerShellPath = null)
    {
        _options = options;
        _logger = logger;
        _onOutput = onOutput;
        PowerShellPath = powerShellPath ?? ResolvePowerShellBinaryPath(options);
        WorkingDirectory = ResolveWorkingDirectory(options);
    }

    public string PowerShellPath { get; }
    public string WorkingDirectory { get; }
    public bool IsRunning => _process is { HasExited: false };
    public int ProcessId => _process?.Id ?? 0;

    /// <summary>
    /// Native window handle of the hosted PowerShell process. Expected to be 0:
    /// the session runs hidden with no console window on the target desktop.
    /// </summary>
    public IntPtr MainWindowHandle => _process?.MainWindowHandle ?? IntPtr.Zero;

    public static string ResolvePowerShellBinaryPath(AgentOptions options)
    {
        return PowerShellResolver.Resolve(options?.PowerShellPath);
    }

    private static string ResolveWorkingDirectory(AgentOptions options)
    {
        string dir = string.IsNullOrWhiteSpace(options.WorkingDirectory)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "ScriptRunnerAgent",
                "work")
            : options.WorkingDirectory;

        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>
    /// Starts the persistent process and verifies that it is responsive.
    /// </summary>
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var psi = new ProcessStartInfo
        {
            FileName = PowerShellPath,
            Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -",
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = WorkingDirectory,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        psi.EnvironmentVariables["SCRIPTRUNNER_TERMINAL"] = "1";
        psi.EnvironmentVariables["SCRIPTRUNNER_AGENT_VERSION"] = "1.0.0";

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.Start();

        _process = process;
        _stdin = process.StandardInput;
        _stdin.AutoFlush = true;

        _ = Task.Run(() => ReadStreamAsync(process.StandardOutput, isStdout: true), CancellationToken.None);
        _ = Task.Run(() => ReadStreamAsync(process.StandardError, isStdout: false), CancellationToken.None);

        // Correct encoding for Windows PowerShell 5.1 as well as PowerShell 7.
        _stdin.WriteLine("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8");

        var probe = await ExecuteInternalAsync(
            "$PSVersionTable.PSVersion.ToString() + ' | ' + (Get-Location).Path",
            TimeSpan.FromSeconds(30),
            capture: true,
            cancellationToken);

        if (!probe.Completed || probe.SessionLost)
        {
            throw new InvalidOperationException("PowerShell session did not respond to the startup probe.");
        }

        _logger.LogInformation(
            "Persistent PowerShell session started (PID {Pid}, {Shell}): {Probe}",
            process.Id, PowerShellPath, probe.Output.Trim());
    }

    private async Task ReadStreamAsync(StreamReader reader, bool isStdout)
    {
        char[] buffer = new char[4096];
        try
        {
            int read;
            while ((read = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length))) > 0)
            {
                string chunk = new string(buffer, 0, read);
                if (isStdout)
                {
                    ProcessStdout(chunk);
                }
                else
                {
                    Emit("stderr", chunk);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogDebug("PowerShell {Stream} reader ended: {Message}",
                isStdout ? "stdout" : "stderr", ex.Message);
        }
        finally
        {
            if (isStdout)
            {
                // The process went away: fail any command in flight.
                CompletePending(new CommandMarker(false, "process-exited", true));
            }
        }
    }

    private void ProcessStdout(string chunk)
    {
        var emitted = new List<string>();
        CommandMarker? completed = null;

        lock (_sync)
        {
            if (_stdoutBuffer.Length == 0 && chunk.Length == 0) return;

            _stdoutBuffer.Append(chunk);

            if (_activeMarker is null)
            {
                // Between commands: any output is session-level chatter.
                emitted.Add(_stdoutBuffer.ToString());
                _stdoutBuffer.Clear();
            }
            else
            {
                string text = _stdoutBuffer.ToString();
                int index = text.IndexOf(_activeMarker, StringComparison.Ordinal);
                int suffixEnd = index >= 0 ? index + _activeMarker.Length + 3 : -1;
                int lineEnd = index >= 0 ? text.IndexOf('\n', index) : -1;

                // Only treat the command as finished once the whole sentinel line
                // (marker + OK/ERR suffix) has arrived, so a partial read can never
                // misreport the exit status.
                if (index >= 0 && (lineEnd >= 0 || text.Length >= suffixEnd))
                {
                    if (index > 0) emitted.Add(text.Substring(0, index));

                    string markerLine = lineEnd >= 0
                        ? text.Substring(index, lineEnd - index)
                        : text.Substring(index, suffixEnd - index);

                    int consumed = lineEnd >= 0 ? lineEnd + 1 : suffixEnd;
                    string rest = consumed < text.Length ? text.Substring(consumed) : string.Empty;

                    _stdoutBuffer.Clear();
                    if (rest.Length > 0) _stdoutBuffer.Append(rest);

                    bool ok = markerLine.TrimEnd().EndsWith("OK", StringComparison.Ordinal);
                    _activeMarker = null;
                    completed = new CommandMarker(ok, markerLine.Trim(), false);
                }
                else if (index < 0)
                {
                    // Hold back only text that could be a partial sentinel.
                    // Everything else is streamed immediately so that chatty or
                    // long-running commands produce live output.
                    int hold = 0;
                    int maxCheck = Math.Min(_activeMarker.Length - 1, text.Length);
                    for (int length = maxCheck; length > 0; length--)
                    {
                        if (text.AsSpan(text.Length - length).SequenceEqual(_activeMarker.AsSpan(0, length)))
                        {
                            hold = length;
                            break;
                        }
                    }

                    int emitLength = text.Length - hold;
                    if (emitLength > 0)
                    {
                        emitted.Add(text.Substring(0, emitLength));
                        _stdoutBuffer.Remove(0, emitLength);
                    }
                }
            }
        }

        foreach (var text in emitted)
        {
            Emit("stdout", text);
        }

        if (completed is not null)
        {
            CompletePending(completed);
        }
    }

    private void Emit(string stream, string text)
    {
        if (string.IsNullOrEmpty(text)) return;

        var capture = _captureBuffer;
        if (capture is not null)
        {
            if (capture.Length < 16384) capture.Append(text);
            return;
        }

        if (_forwardedChars >= _options.MaxTerminalCommandOutputChars)
        {
            if (!_truncated)
            {
                _truncated = true;
                _onOutput(new TerminalOutputChunk
                {
                    Stream = "system",
                    Content =
                        $"\r\n[output truncated after {_options.MaxTerminalCommandOutputChars:N0} characters; the command keeps running]\r\n"
                });
            }
            return;
        }

        int allowed = Math.Min(text.Length, _options.MaxTerminalCommandOutputChars - _forwardedChars);
        string slice = allowed == text.Length ? text : text.Substring(0, allowed);
        _forwardedChars += allowed;

        // Access-denied heuristic (reported clearly when privileges are missing)
        string tail = (_recentOutputTail + slice);
        if (tail.Length > 400) tail = tail[^400..];
        _recentOutputTail = tail;
        if (tail.Contains("Access is denied", StringComparison.OrdinalIgnoreCase) ||
            tail.Contains("requires elevation", StringComparison.OrdinalIgnoreCase) ||
            tail.Contains("Requested registry access is not allowed", StringComparison.OrdinalIgnoreCase))
        {
            _accessDenied = true;
        }

        _onOutput(new TerminalOutputChunk { Stream = stream, Content = slice });
    }

    private void CompletePending(CommandMarker marker)
    {
        TaskCompletionSource<CommandMarker>? completion;
        lock (_sync)
        {
            completion = _pendingCompletion;
            _pendingCompletion = null;
        }

        completion?.TrySetResult(marker);
    }

    /// <summary>
    /// Runs a command and returns its output without forwarding it to the terminal.
    /// Used for internal session metadata (e.g. the command-completion list).
    /// </summary>
    public async Task<string> CaptureOutputAsync(string command, CancellationToken cancellationToken)
    {
        var result = await ExecuteInternalAsync(
            command,
            TimeSpan.FromSeconds(20),
            capture: true,
            cancellationToken);
        return result.Output;
    }

    public async Task<TerminalCommandOutcome> ExecuteAsync(
        string command,
        CancellationToken cancellationToken)
    {
        var result = await ExecuteInternalAsync(
            command,
            TimeSpan.FromSeconds(Math.Max(5, _options.TerminalCommandTimeoutSeconds)),
            capture: false,
            cancellationToken);

        return new TerminalCommandOutcome
        {
            ExitOk = result.ExitOk && !result.SessionLost && !result.TimedOut,
            TimedOut = result.TimedOut,
            SessionLost = result.SessionLost,
            Truncated = result.Truncated,
            AccessDeniedHint = result.AccessDenied,
            Error = result.Error
        };
    }

    private async Task<InternalResult> ExecuteInternalAsync(
        string command,
        TimeSpan timeout,
        bool capture,
        CancellationToken cancellationToken)
    {
        if (_process is null || _stdin is null || _process.HasExited)
        {
            return new InternalResult
            {
                SessionLost = true,
                Error = "PowerShell session is not running"
            };
        }

        var completion = new TaskCompletionSource<CommandMarker>(TaskCreationOptions.RunContinuationsAsynchronously);
        string marker = SentinelPrefix + Guid.NewGuid().ToString("N") + "__";

        lock (_sync)
        {
            _pendingCompletion = completion;
            _activeMarker = marker;
            _forwardedChars = 0;
            _truncated = false;
            _accessDenied = false;
            _recentOutputTail = string.Empty;
            // Capture mode is used only for the startup probe; its output must not
            // leak into the terminal history.
            _captureBuffer = capture ? new StringBuilder() : null;
        }

        // Send the command, then a sentinel line. PowerShell executes stdin lines
        // sequentially in the same session state, so the sentinel runs only after
        // the command finishes.
        // Capture $? into a variable *before* writing the newline: writing the
        // newline is itself a successful statement and would otherwise reset $?.
        string trailer =
            "$__sr_ok = $?; [Console]::Out.Write([Environment]::NewLine); Out-Default; Write-Output ('" + marker +
            "' + $(if ($__sr_ok) { 'OK' } else { 'ERR' })); Out-Default; [Console]::Out.Flush()";

        string normalized = command.Replace("\r\n", "\n").Replace("\r", "\n");
        // Ensure standalone closing braces have an empty line after them so interactive stdin
        // commits the block statement without waiting.
        normalized = Regex.Replace(normalized, @"(?m)^\s*\}\s*$", "}\n");

        try
        {
            _stdin.WriteLine(normalized);
            _stdin.WriteLine(trailer);
            _stdin.WriteLine();
            _stdin.Flush();
        }
        catch (Exception ex)
        {
            return new InternalResult
            {
                SessionLost = true,
                Error = $"Failed to write to PowerShell stdin: {ex.Message}"
            };
        }

        Task<CommandMarker> completedTask = completion.Task;
        Task timeoutTask = Task.Delay(timeout, cancellationToken);

        Task finished = await Task.WhenAny(completedTask, timeoutTask);

        if (finished == timeoutTask)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _captureBuffer = null;
            // The session is likely blocked on stdin (interactive prompt or an
            // infinitely running command). It cannot be recovered reliably.
            await DisposeAsync();
            return new InternalResult
            {
                TimedOut = true,
                Truncated = _truncated,
                AccessDenied = _accessDenied,
                Error = $"Command did not complete within {timeout.TotalSeconds:N0} seconds; the PowerShell session was reset and session state was lost."
            };
        }

        var markerResult = await completedTask;
        string capturedOutput;
        lock (_sync)
        {
            capturedOutput = _captureBuffer?.ToString() ?? string.Empty;
            _captureBuffer = null;
        }

        return new InternalResult
        {
            Completed = !markerResult.SessionLost,
            SessionLost = markerResult.SessionLost,
            TimedOut = false,
            ExitOk = markerResult.Ok,
            Truncated = _truncated,
            AccessDenied = _accessDenied,
            Error = markerResult.SessionLost ? markerResult.Marker : null,
            Output = capture ? capturedOutput : string.Empty
        };
    }

    /// <summary>
    /// Detects commands that would wait for interactive input or require a visible
    /// desktop. The remote terminal is noninteractive by design; these are rejected
    /// with an explanation instead of hanging the session.
    /// </summary>
    public static string? DetectUnsupportedCommand(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return "Command is empty.";

        if (Regex.IsMatch(command, @"\b(Read-Host|Get-Credential|Out-GridView|Show-Command|PromptForChoice)\b",
                RegexOptions.IgnoreCase) ||
            Regex.IsMatch(command, @"\[Console\]::Read(Key|Line)\s*\(", RegexOptions.IgnoreCase) ||
            Regex.IsMatch(command, @"\bReadLine\s*\(|\bReadKey\s*\(", RegexOptions.IgnoreCase))
        {
            return "This command prompts for interactive input. The remote terminal is noninteractive; " +
                   "pass parameters instead (for example -Credential, -Force, or explicit values).";
        }

        if (Regex.IsMatch(command,
                @"(^|[;|&]\s*)(notepad|mspaint|calc|explorer|control|mshta|mmc)(\.exe)?\b",
                RegexOptions.IgnoreCase))
        {
            return "This command launches an interactive desktop application. The agent runs in a " +
                   "noninteractive service session, so no GUI can be displayed on the target desktop.";
        }

        if (Regex.IsMatch(command, @"\bshutdown(\.exe)?\b[^\r\n]*\/i\b", RegexOptions.IgnoreCase))
        {
            return "Interactive shutdown dialog (/i) is not available in a noninteractive service session.";
        }

        return null;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        var process = _process;
        _process = null;

        if (process is not null)
        {
            try
            {
                if (!process.HasExited)
                {
                    try
                    {
                        _stdin?.WriteLine("exit");
                        _stdin?.Flush();
                    }
                    catch { /* ignore */ }

                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    try
                    {
                        await process.WaitForExitAsync(cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug("Error while stopping PowerShell session: {Message}", ex.Message);
            }
            finally
            {
                try { _stdin?.Dispose(); } catch { }
                process.Dispose();
            }
        }

        CompletePending(new CommandMarker(false, "session-disposed", true));
    }

    private sealed record CommandMarker(bool Ok, string Marker, bool SessionLost);

    private sealed class InternalResult
    {
        public bool Completed { get; init; }
        public bool SessionLost { get; init; }
        public bool TimedOut { get; init; }
        public bool ExitOk { get; init; }
        public bool Truncated { get; init; }
        public bool AccessDenied { get; init; }
        public string? Error { get; init; }
        public string Output { get; init; } = string.Empty;
    }
}
