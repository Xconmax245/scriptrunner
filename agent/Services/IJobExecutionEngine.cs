using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

public interface IJobExecutionEngine
{
    /// <summary>
    /// Executes a PowerShell script non-interactively in the background with strict timeout,
    /// bounded stdout/stderr capture, output redaction, and complete process tree termination on timeout.
    /// </summary>
    Task<ExecutionResult> ExecuteScriptAsync(
        string scriptContent,
        int timeoutSeconds,
        CancellationToken cancellationToken);
}
