using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

public class JobExecutionEngine : IJobExecutionEngine
{
    private readonly AgentOptions _options;
    private readonly ILogger<JobExecutionEngine> _logger;
    private readonly string _resolvedPowerShellPath;

    // Redaction patterns for sensitive data in execution outputs
    private static readonly Regex[] RedactionRules = new[]
    {
        new Regex(@"(?i)(password|passwd|pwd|secret|api[_-]?key|bearer|token)\s*[:=]\s*['""]?([^'""\s,;]+)['""]?", RegexOptions.Compiled),
        new Regex(@"(?i)Authorization:\s*Bearer\s+[A-Za-z0-9\-_\.]+", RegexOptions.Compiled),
        new Regex(@"sbp_[A-Za-z0-9_]{30,}", RegexOptions.Compiled), // Supabase personal token
        new Regex(@"eyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}", RegexOptions.Compiled), // JWT pattern
    };

    public JobExecutionEngine(
        IOptions<AgentOptions> options,
        ILogger<JobExecutionEngine> logger)
    {
        _options = options.Value;
        _logger = logger;
        _resolvedPowerShellPath = ResolvePowerShellBinaryPath();
    }

    private string ResolvePowerShellBinaryPath()
    {
        return PowerShellResolver.Resolve(_options.PowerShellPath, _logger);
    }

    public async Task<ExecutionResult> ExecuteScriptAsync(
        string scriptContent,
        int timeoutSeconds,
        CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        string tempScriptPath = Path.Combine(Path.GetTempPath(), $"sr-job-{Guid.NewGuid():N}.ps1");

        try
        {
            // Write script content to a secure temporary file with UTF-8 encoding
            await File.WriteAllTextAsync(tempScriptPath, scriptContent, Encoding.UTF8, cancellationToken);

            var startInfo = new ProcessStartInfo
            {
                FileName = _resolvedPowerShellPath,
                Arguments = $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{tempScriptPath}\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = string.IsNullOrEmpty(_options.WorkingDirectory)
                    ? Path.GetTempPath()
                    : _options.WorkingDirectory
            };

            // Set clean environment variables to avoid ambient state leaks
            startInfo.EnvironmentVariables["SCRIPTRUNNER_EXECUTION"] = "1";
            startInfo.EnvironmentVariables["SCRIPTRUNNER_AGENT_VERSION"] = "1.0.0";

            using var process = new Process { StartInfo = startInfo };
            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

            var stdoutBuilder = new StringBuilder();
            var stderrBuilder = new StringBuilder();
            bool stdoutTruncated = false;
            bool stderrTruncated = false;
            int maxStdout = _options.MaxStdoutBytes > 0 ? _options.MaxStdoutBytes : 65536;
            int maxStderr = _options.MaxStderrBytes > 0 ? _options.MaxStderrBytes : 16384;

            _logger.LogInformation("Spawning background PowerShell process (Timeout: {Timeout}s)...", timeoutSeconds);
            process.Start();

            // Read output asynchronously with bounding limits
            var stdoutTask = Task.Run(async () =>
            {
                char[] buffer = new char[4096];
                int totalChars = 0;
                int read;
                while ((read = await process.StandardOutput.ReadAsync(buffer, 0, buffer.Length)) > 0)
                {
                    if (totalChars < maxStdout)
                    {
                        int toAppend = Math.Min(read, maxStdout - totalChars);
                        stdoutBuilder.Append(buffer, 0, toAppend);
                        totalChars += toAppend;
                    }
                    else
                    {
                        stdoutTruncated = true;
                    }
                }
            });

            var stderrTask = Task.Run(async () =>
            {
                char[] buffer = new char[2048];
                int totalChars = 0;
                int read;
                while ((read = await process.StandardError.ReadAsync(buffer, 0, buffer.Length)) > 0)
                {
                    if (totalChars < maxStderr)
                    {
                        int toAppend = Math.Min(read, maxStderr - totalChars);
                        stderrBuilder.Append(buffer, 0, toAppend);
                        totalChars += toAppend;
                    }
                    else
                    {
                        stderrTruncated = true;
                    }
                }
            });

            bool timedOut = false;
            try
            {
                await process.WaitForExitAsync(linkedCts.Token);
                await Task.WhenAll(stdoutTask, stderrTask);
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
            {
                timedOut = true;
                _logger.LogWarning("Script execution exceeded timeout of {Timeout}s. Terminating process tree...", timeoutSeconds);
                try
                {
                    // Kill process tree to prevent orphaned child processes
                    process.Kill(entireProcessTree: true);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error while killing process tree on timeout");
                }
            }

            var completedAt = DateTimeOffset.UtcNow;
            string stdout = RedactSensitiveOutput(stdoutBuilder.ToString());
            string stderr = RedactSensitiveOutput(stderrBuilder.ToString());

            if (timedOut)
            {
                return new ExecutionResult
                {
                    ExitCode = -1,
                    Stdout = stdout,
                    StdoutTruncated = stdoutTruncated,
                    Stderr = stderr,
                    StderrTruncated = stderrTruncated,
                    StartedAt = startedAt,
                    CompletedAt = completedAt,
                    IsTimedOut = true,
                    ErrorSummary = $"Execution timed out after {timeoutSeconds} seconds. Process tree killed."
                };
            }

            int exitCode = process.ExitCode;
            return new ExecutionResult
            {
                ExitCode = exitCode,
                Stdout = stdout,
                StdoutTruncated = stdoutTruncated,
                Stderr = stderr,
                StderrTruncated = stderrTruncated,
                StartedAt = startedAt,
                CompletedAt = completedAt,
                IsTimedOut = false,
                ErrorSummary = exitCode != 0 ? $"Process exited with code {exitCode}" : null
            };
        }
        finally
        {
            // Secure cleanup of temporary script file
            try
            {
                if (File.Exists(tempScriptPath))
                {
                    File.Delete(tempScriptPath);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to clean up temporary script file: {Path}", tempScriptPath);
            }
        }
    }

    private static string RedactSensitiveOutput(string input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;

        string redacted = input;
        foreach (var rule in RedactionRules)
        {
            redacted = rule.Replace(redacted, "[REDACTED_SECRET]");
        }
        return redacted;
    }
}
