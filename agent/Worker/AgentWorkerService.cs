using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;

namespace ScriptRunnerAgent.Worker;

public class AgentWorkerService : BackgroundService
{
    private readonly ISupabaseApiClient _apiClient;
    private readonly IJobExecutionEngine _executionEngine;
    private readonly IStatePersistenceManager _stateManager;
    private readonly EnrollmentService _enrollment;
    private readonly AgentOptions _options;
    private readonly AgentRuntimeState _runtime;
    private readonly ILogger<AgentWorkerService> _logger;

    public AgentWorkerService(
        ISupabaseApiClient apiClient,
        IJobExecutionEngine executionEngine,
        IStatePersistenceManager stateManager,
        EnrollmentService enrollment,
        AgentRuntimeState runtime,
        IOptions<AgentOptions> options,
        ILogger<AgentWorkerService> logger)
    {
        _apiClient = apiClient;
        _executionEngine = executionEngine;
        _stateManager = stateManager;
        _enrollment = enrollment;
        _runtime = runtime;
        _options = options.Value;
        _logger = logger;
    }

    private AgentTelemetry BuildTelemetry() => new()
    {
        Hostname = Environment.MachineName,
        OperatingSystem = OperatingSystemInfo.Describe(),
        AgentVersion = "1.1.0",
        ServiceStatus = "running",
        IsElevated = ExecutionContextInfo.IsElevated,
        ExecutionAccount = ExecutionContextInfo.AccountName,
        ConnectionFailures = _runtime.ConnectionFailures,
        ReconnectAttempts = _runtime.ReconnectAttempts,
        RestartRequired = _runtime.RestartRequired
    };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var initialTelemetry = BuildTelemetry();
        _logger.LogInformation(
            "ScriptRunner Agent starting. Device ID: {DeviceId}, host: {Hostname}, account: {Account}.",
            _enrollment.DeviceId, initialTelemetry.Hostname, initialTelemetry.ExecutionAccount);

        await InitializeAgentAsync(stoppingToken);

        int currentDelaySeconds = Math.Max(1, _options.PollIntervalSeconds);
        var random = new Random();
        DateTimeOffset nextHeartbeat = DateTimeOffset.UtcNow;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Automatic enrollment / authorization gate. With the default
                // policy a freshly installed device waits here until an
                // administrator authorizes it; nothing is executed before that.
                if (!await _enrollment.EnsureAuthorizedAsync(stoppingToken))
                {
                    if (_enrollment.State == AgentAuthorizationState.Revoked)
                    {
                        _logger.LogError("Device is revoked. No commands will be processed.");
                        await Task.Delay(TimeSpan.FromSeconds(60), stoppingToken);
                        continue;
                    }

                    await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                    continue;
                }

                if (DateTimeOffset.UtcNow >= nextHeartbeat)
                {
                    var heartbeat = await _apiClient.SendHeartbeatAsync(BuildTelemetry(), stoppingToken);

                    if (heartbeat.Success)
                    {
                        _runtime.RecordSuccess();
                    }
                    else
                    {
                        _runtime.RecordFailure();
                    }

                    if (!heartbeat.Success && (heartbeat.Revoked || heartbeat.NotAuthorized))
                    {
                        _enrollment.MarkNotAuthorized(
                            heartbeat.Revoked ? "revoked" : heartbeat.EnrollmentStatus,
                            heartbeat.Error);
                        nextHeartbeat = DateTimeOffset.UtcNow.AddSeconds(10);
                        continue;
                    }

                    nextHeartbeat = DateTimeOffset.UtcNow.AddSeconds(
                        Math.Max(15, _options.HeartbeatIntervalSeconds));
                }

                var pendingJobs = await _apiClient.GetPendingJobsAsync(stoppingToken);

                if (pendingJobs.Count > 0)
                {
                    _logger.LogInformation("Discovered {Count} eligible pending job(s).", pendingJobs.Count);

                    foreach (var job in pendingJobs)
                    {
                        if (stoppingToken.IsCancellationRequested) break;

                        if (job.ExpiresAt <= DateTimeOffset.UtcNow)
                        {
                            _logger.LogWarning(
                                "Job {JobId} has expired (Deadline: {ExpiresAt:u}). Skipping execution.",
                                job.Id, job.ExpiresAt);
                            continue;
                        }

                        var claimResult = await _apiClient.ClaimJobAsync(job.Id, stoppingToken);
                        if (!claimResult.Success || !claimResult.JobId.HasValue)
                        {
                            _logger.LogInformation("Job {JobId} could not be claimed: {Error}",
                                job.Id, claimResult.Error);
                            continue;
                        }

                        await ProcessClaimedJobAsync(claimResult, stoppingToken);
                        currentDelaySeconds = Math.Max(1, _options.PollIntervalSeconds);
                    }
                }
                else
                {
                    currentDelaySeconds = Math.Max(1, _options.PollIntervalSeconds);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                _logger.LogInformation("Agent worker shutdown requested.");
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error in agent polling loop. Backing off...");
                _runtime.RecordFailure();
                currentDelaySeconds = Math.Min(
                    currentDelaySeconds * 2,
                    Math.Max(30, _options.MaxBackoffSeconds));
            }

            int jitterMs = random.Next(-500, 500);
            int sleepMs = Math.Max(1000, (currentDelaySeconds * 1000) + jitterMs);
            await Task.Delay(sleepMs, stoppingToken);
        }

        _logger.LogInformation("ScriptRunner Agent stopped gracefully.");
    }

    private async Task InitializeAgentAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _enrollment.EnsureAuthorizedAsync(cancellationToken);
            await ReconcileStartupStateAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during agent initialization and startup reconciliation");
        }
    }

    private async Task ReconcileStartupStateAsync(CancellationToken cancellationToken)
    {
        var localState = await _stateManager.LoadInFlightStateAsync(cancellationToken);
        if (localState == null)
        {
            _logger.LogDebug("No local in-flight execution state found. Clean start.");
            return;
        }

        _logger.LogWarning("Discovered in-flight state file for Job {JobId} from prior session.", localState.JobId);

        if (localState.ExecutionCompleted && localState.CachedResult != null)
        {
            _logger.LogInformation(
                "Job {JobId} completed execution before restart. Retrying completion report...",
                localState.JobId);

            var reportReq = new ReportCompletionRequest
            {
                DeviceId = _enrollment.DeviceId,
                JobId = localState.JobId,
                AttemptNumber = localState.AttemptNumber,
                AgentExecutionId = localState.AgentExecutionId,
                State = localState.CachedResult.IsSuccess ? "succeeded" : "failed",
                Outcome = localState.CachedResult.IsSuccess ? "succeeded" : "failed",
                ExitCode = localState.CachedResult.ExitCode,
                Stdout = localState.CachedResult.Stdout,
                StdoutTruncated = localState.CachedResult.StdoutTruncated,
                Stderr = localState.CachedResult.Stderr,
                StderrTruncated = localState.CachedResult.StderrTruncated,
                StartedAt = localState.CachedResult.StartedAt,
                CompletedAt = localState.CachedResult.CompletedAt,
                ErrorSummary = localState.CachedResult.ErrorSummary
            };

            bool reported = await _apiClient.ReportJobCompletionAsync(reportReq, cancellationToken);
            if (reported)
            {
                await _stateManager.ClearInFlightStateAsync(cancellationToken);
            }
        }
        else
        {
            _logger.LogWarning(
                "Job {JobId} was abruptly terminated mid-execution. Reporting outcome_unknown to avoid duplicate execution.",
                localState.JobId);

            var unknownReq = new ReportCompletionRequest
            {
                DeviceId = _enrollment.DeviceId,
                JobId = localState.JobId,
                AttemptNumber = localState.AttemptNumber,
                AgentExecutionId = localState.AgentExecutionId,
                State = "outcome_unknown",
                Outcome = "outcome_unknown",
                ExitCode = -999,
                Stdout = "[Execution interrupted by host restart or service crash]",
                Stderr = string.Empty,
                StartedAt = localState.StartedAt,
                CompletedAt = DateTimeOffset.UtcNow,
                ErrorSummary = "Execution interrupted by host restart or power loss. Outcome unknown."
            };

            await _apiClient.ReportJobCompletionAsync(unknownReq, cancellationToken);
            await _stateManager.ClearInFlightStateAsync(cancellationToken);
        }
    }

    private async Task ProcessClaimedJobAsync(ClaimJobResponse job, CancellationToken cancellationToken)
    {
        Guid jobId = job.JobId!.Value;
        int timeoutSec = job.TimeoutSeconds ?? 300;
        string scriptContent = job.ScriptContent ?? string.Empty;
        int attemptNumber = job.AttemptNumber ?? 1;
        string agentExecutionId = Guid.NewGuid().ToString("N");
        var startedAt = DateTimeOffset.UtcNow;

        _logger.LogInformation("Executing Job {JobId} (Attempt: {Attempt}, Timeout: {Timeout}s)...",
            jobId, attemptNumber, timeoutSec);

        var localState = new LocalExecutionState
        {
            JobId = jobId,
            AttemptNumber = attemptNumber,
            AgentExecutionId = agentExecutionId,
            ScriptHash = job.ScriptHash ?? string.Empty,
            StartedAt = startedAt,
            ExecutionCompleted = false
        };
        await _stateManager.SaveInFlightStateAsync(localState, cancellationToken);

        await _apiClient.MarkJobRunningAsync(jobId, attemptNumber, agentExecutionId, startedAt, cancellationToken);

        ExecutionResult result = await _executionEngine.ExecuteScriptAsync(
            scriptContent,
            timeoutSec,
            cancellationToken);

        await _stateManager.UpdateCompletedResultAsync(result, cancellationToken);

        string stateStr = result.IsTimedOut
            ? "timed_out"
            : result.IsSuccess
                ? "succeeded"
                : "failed";

        _logger.LogInformation(
            "Job {JobId} finished with outcome {Outcome} (ExitCode: {ExitCode}, Duration: {Duration:N1}s)",
            jobId, stateStr, result.ExitCode, result.Duration.TotalSeconds);

        var completionReq = new ReportCompletionRequest
        {
            DeviceId = _enrollment.DeviceId,
            JobId = jobId,
            AttemptNumber = attemptNumber,
            AgentExecutionId = agentExecutionId,
            State = stateStr,
            Outcome = stateStr,
            ExitCode = result.ExitCode,
            Stdout = result.Stdout,
            StdoutTruncated = result.StdoutTruncated,
            Stderr = result.Stderr,
            StderrTruncated = result.StderrTruncated,
            StartedAt = result.StartedAt,
            CompletedAt = result.CompletedAt,
            ErrorSummary = result.ErrorSummary
        };

        bool acknowledged = await _apiClient.ReportJobCompletionAsync(completionReq, cancellationToken);

        if (acknowledged)
        {
            await _stateManager.ClearInFlightStateAsync(cancellationToken);
        }
        else
        {
            _logger.LogWarning(
                "Failed to report completion for Job {JobId}. Cached result retained locally for restart retry.",
                jobId);
        }
    }
}
