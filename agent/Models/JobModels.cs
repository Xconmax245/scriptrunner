using System.Text.Json.Serialization;

namespace ScriptRunnerAgent.Models;

public enum ScriptType
{
    [JsonPropertyName("powershell")]
    PowerShell
}

public enum JobState
{
    [JsonPropertyName("queued")]
    Queued,
    [JsonPropertyName("waiting_for_device")]
    WaitingForDevice,
    [JsonPropertyName("claimed")]
    Claimed,
    [JsonPropertyName("running")]
    Running,
    [JsonPropertyName("succeeded")]
    Succeeded,
    [JsonPropertyName("failed")]
    Failed,
    [JsonPropertyName("timed_out")]
    TimedOut,
    [JsonPropertyName("cancelled")]
    Cancelled,
    [JsonPropertyName("expired")]
    Expired,
    [JsonPropertyName("outcome_unknown")]
    OutcomeUnknown
}

public class PendingJobItem
{
    [JsonPropertyName("id")]
    public Guid Id { get; set; }

    [JsonPropertyName("organization_id")]
    public Guid OrganizationId { get; set; }

    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("script_content")]
    public string ScriptContent { get; set; } = string.Empty;

    [JsonPropertyName("script_type")]
    public string ScriptType { get; set; } = "powershell";

    [JsonPropertyName("script_hash")]
    public string ScriptHash { get; set; } = string.Empty;

    [JsonPropertyName("state")]
    public string State { get; set; } = string.Empty;

    [JsonPropertyName("timeout_seconds")]
    public int TimeoutSeconds { get; set; } = 300;

    [JsonPropertyName("expires_at")]
    public DateTimeOffset ExpiresAt { get; set; }

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    [JsonPropertyName("not_before")]
    public DateTimeOffset? NotBefore { get; set; }
}

public class ClaimJobRequest
{
    [JsonPropertyName("p_device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("p_device_api_key")]
    public string DeviceApiKey { get; set; } = string.Empty;

    [JsonPropertyName("p_job_id")]
    public Guid JobId { get; set; }
}

public class ClaimJobResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("job_id")]
    public Guid? JobId { get; set; }

    [JsonPropertyName("script_content")]
    public string? ScriptContent { get; set; }

    [JsonPropertyName("script_hash")]
    public string? ScriptHash { get; set; }

    [JsonPropertyName("timeout_seconds")]
    public int? TimeoutSeconds { get; set; }

    [JsonPropertyName("attempt_number")]
    public int? AttemptNumber { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

public class ReportRunningRequest
{
    [JsonPropertyName("p_device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("p_device_api_key")]
    public string DeviceApiKey { get; set; } = string.Empty;

    [JsonPropertyName("p_job_id")]
    public Guid JobId { get; set; }

    [JsonPropertyName("p_attempt_number")]
    public int AttemptNumber { get; set; }

    [JsonPropertyName("p_agent_execution_id")]
    public string AgentExecutionId { get; set; } = string.Empty;

    [JsonPropertyName("p_started_at")]
    public DateTimeOffset StartedAt { get; set; }
}

public class ReportCompletionRequest
{
    [JsonPropertyName("p_device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("p_device_api_key")]
    public string DeviceApiKey { get; set; } = string.Empty;

    [JsonPropertyName("p_job_id")]
    public Guid JobId { get; set; }

    [JsonPropertyName("p_attempt_number")]
    public int AttemptNumber { get; set; }

    [JsonPropertyName("p_agent_execution_id")]
    public string AgentExecutionId { get; set; } = string.Empty;

    [JsonPropertyName("p_state")]
    public string State { get; set; } = string.Empty; // 'succeeded', 'failed', 'timed_out', 'outcome_unknown'

    [JsonPropertyName("p_outcome")]
    public string Outcome { get; set; } = string.Empty;

    [JsonPropertyName("p_exit_code")]
    public int? ExitCode { get; set; }

    [JsonPropertyName("p_stdout")]
    public string? Stdout { get; set; }

    [JsonPropertyName("p_stdout_truncated")]
    public bool StdoutTruncated { get; set; }

    [JsonPropertyName("p_stderr")]
    public string? Stderr { get; set; }

    [JsonPropertyName("p_stderr_truncated")]
    public bool StderrTruncated { get; set; }

    [JsonPropertyName("p_started_at")]
    public DateTimeOffset StartedAt { get; set; }

    [JsonPropertyName("p_completed_at")]
    public DateTimeOffset CompletedAt { get; set; }

    [JsonPropertyName("p_error_summary")]
    public string? ErrorSummary { get; set; }
}

public class HeartbeatRequest
{
    [JsonPropertyName("p_device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("p_device_api_key")]
    public string DeviceApiKey { get; set; } = string.Empty;

    [JsonPropertyName("p_hostname")]
    public string Hostname { get; set; } = string.Empty;

    [JsonPropertyName("p_operating_system")]
    public string OperatingSystem { get; set; } = string.Empty;

    [JsonPropertyName("p_agent_version")]
    public string AgentVersion { get; set; } = string.Empty;
}

public class HeartbeatResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("is_revoked")]
    public bool IsRevoked { get; set; }

    [JsonPropertyName("pending_jobs_count")]
    public int PendingJobsCount { get; set; }

    [JsonPropertyName("server_time")]
    public DateTimeOffset? ServerTime { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

public class ExecutionResult
{
    public int ExitCode { get; set; }
    public string Stdout { get; set; } = string.Empty;
    public bool StdoutTruncated { get; set; }
    public string Stderr { get; set; } = string.Empty;
    public bool StderrTruncated { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public TimeSpan Duration => CompletedAt - StartedAt;
    public bool IsTimedOut { get; set; }
    public bool IsSuccess => !IsTimedOut && ExitCode == 0;
    public string? ErrorSummary { get; set; }
}

public class LocalExecutionState
{
    public Guid JobId { get; set; }
    public string AgentExecutionId { get; set; } = string.Empty;
    public int AttemptNumber { get; set; }
    public string ScriptHash { get; set; } = string.Empty;
    public DateTimeOffset StartedAt { get; set; }
    public bool ExecutionCompleted { get; set; }
    public ExecutionResult? CachedResult { get; set; }
}
