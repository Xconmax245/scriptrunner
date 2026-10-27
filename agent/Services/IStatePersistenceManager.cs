using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

public interface IStatePersistenceManager
{
    /// <summary>
    /// Persists an in-flight execution state to disk before launching the script subprocess.
    /// This ensures crash recovery can determine if an interrupted job began execution.
    /// </summary>
    Task SaveInFlightStateAsync(LocalExecutionState state, CancellationToken cancellationToken);

    /// <summary>
    /// Loads the active in-flight execution state from disk upon service startup.
    /// </summary>
    Task<LocalExecutionState?> LoadInFlightStateAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Updates the state file with the completed execution result so if network reporting fails,
    /// subsequent retries will send the cached result rather than re-running the script.
    /// </summary>
    Task UpdateCompletedResultAsync(ExecutionResult result, CancellationToken cancellationToken);

    /// <summary>
    /// Cleans up the state file after the completion has been successfully acknowledged by Supabase.
    /// </summary>
    Task ClearInFlightStateAsync(CancellationToken cancellationToken);
}
