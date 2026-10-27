using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

public interface ISupabaseApiClient
{
    /// <summary>
    /// Authenticates the agent with the device-auth Edge Function using its
    /// private device API key and caches the short-lived device JWT.
    /// </summary>
    Task<AuthResult> AuthenticateAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Registers this installation with the organization enrollment key. The
    /// device ID and install ID are generated locally, never typed by an operator.
    /// </summary>
    Task<EnrollmentResponse> EnrollAsync(DeviceIdentity identity, CancellationToken cancellationToken);

    /// <summary>
    /// Reports hostname, OS, agent version, service state, execution context and
    /// communication health. The response carries the organisation's RMM policy.
    /// </summary>
    Task<HeartbeatResult> SendHeartbeatAsync(AgentTelemetry telemetry, CancellationToken cancellationToken);

    // ------------------------------------------------------------------
    // RMM: inventory, telemetry, monitors and software deployment
    // ------------------------------------------------------------------

    /// <summary>Fetches monitor definitions and collection intervals for this device.</summary>
    Task<AgentRmmConfig?> GetAgentConfigAsync(CancellationToken cancellationToken);

    /// <summary>Uploads a hardware/OS/network inventory snapshot.</summary>
    Task<bool> SendInventoryAsync(
        HardwareInventory hardware,
        OperatingSystemInventory os,
        NetworkInventory network,
        IReadOnlyList<string> dataQuality,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken);

    /// <summary>Uploads a bounded batch of metric samples.</summary>
    Task<bool> SendMetricsAsync(
        IReadOnlyList<MetricSample> samples,
        CancellationToken cancellationToken);

    /// <summary>Uploads an installed-application scan for server-side diffing.</summary>
    Task<bool> SendSoftwareInventoryAsync(
        IReadOnlyList<SoftwareApplication> applications,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken);

    /// <summary>Uploads Windows event log entries (deduplicated server-side).</summary>
    Task<bool> SendEventsAsync(
        IReadOnlyList<EventLogEntryDto> events,
        CancellationToken cancellationToken);

    /// <summary>Reports the outcome of one monitor execution.</summary>
    Task<bool> ReportMonitorResultAsync(
        Guid monitorId,
        MonitorOutcome outcome,
        DateTimeOffset observedAt,
        CancellationToken cancellationToken);

    /// <summary>Claims the next approved deployment atomically.</summary>
    Task<DeploymentWorkItem?> ClaimDeploymentAsync(CancellationToken cancellationToken);

    /// <summary>Reports deployment phase/progress and terminal outcome.</summary>
    Task<bool> UpdateDeploymentAsync(
        Guid jobId,
        string state,
        int? progress,
        int? exitCode,
        string? output,
        string? error,
        bool? rebootRequired,
        CancellationToken cancellationToken);

    /// <summary>
    /// Queries pending, non-expired jobs assigned exclusively to this device.
    /// </summary>
    Task<List<PendingJobItem>> GetPendingJobsAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Atomically claims the next eligible job for this device.
    /// </summary>
    Task<ClaimJobResponse> ClaimJobAsync(Guid jobId, CancellationToken cancellationToken);

    /// <summary>
    /// Notifies the server that process execution has started for the job attempt.
    /// </summary>
    Task<bool> MarkJobRunningAsync(Guid jobId, int attemptNumber, string agentExecutionId, DateTimeOffset startedAt, CancellationToken cancellationToken);

    /// <summary>
    /// Reports the final execution result (stdout, stderr, exit code, duration, outcome).
    /// Retries on transient network failures without re-executing the script.
    /// </summary>
    Task<bool> ReportJobCompletionAsync(ReportCompletionRequest request, CancellationToken cancellationToken);

    /// <summary>
    /// Checks for incomplete in-flight jobs on startup for state reconciliation.
    /// </summary>
    Task<List<LocalExecutionState>> GetAmbiguousJobsAsync(CancellationToken cancellationToken);

    // ------------------------------------------------------------------
    // Remote terminal transport (long-poll + ordered output streaming)
    // ------------------------------------------------------------------

    /// <summary>
    /// Picks up a terminal session an administrator opened for this device.
    /// </summary>
    Task<TerminalClaimResult?> ClaimTerminalSessionAsync(string agentInstanceId, CancellationToken cancellationToken);

    /// <summary>
    /// Long-poll for commands on a session. The server holds the request up to
    /// ~20 seconds and returns as soon as a command is available.
    /// </summary>
    Task<TerminalPollResult> PollTerminalCommandsAsync(Guid sessionId, CancellationToken cancellationToken);

    /// <summary>
    /// Streams an ordered batch of output chunks back to the dashboard.
    /// </summary>
    Task<TerminalOutputAck?> SendTerminalOutputAsync(Guid sessionId, IReadOnlyList<TerminalOutputChunk> chunks, CancellationToken cancellationToken);

    /// <summary>
    /// Lightweight session/device state check used while a command is executing,
    /// so revocation or an administrator disconnect stops it promptly.
    /// </summary>
    Task<TerminalSessionState> GetTerminalSessionStateAsync(Guid sessionId, CancellationToken cancellationToken);

    /// <summary>
    /// Reports whether a command completed successfully (exit status).
    /// </summary>
    Task<bool> ReportTerminalCommandResultAsync(Guid sessionId, long sequence, bool exitOk, string? error, CancellationToken cancellationToken);

    /// <summary>
    /// Notifies the server that the agent-side session ended (e.g. agent restart).
    /// </summary>
    Task<bool> EndTerminalSessionAsync(Guid sessionId, string reason, CancellationToken cancellationToken);
}
