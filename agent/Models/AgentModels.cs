using System.Text.Json.Serialization;

namespace ScriptRunnerAgent.Models;

public enum AgentAuthorizationState
{
    Unknown,
    Enrolling,
    AwaitingAuthorization,
    Authorized,
    Suspended,
    Revoked
}

public sealed class AgentTelemetry
{
    public string Hostname { get; init; } = Environment.MachineName;
    public string OperatingSystem { get; init; } = string.Empty;
    public string AgentVersion { get; init; } = "1.0.0";
    public string ServiceStatus { get; init; } = "running";
    public bool IsElevated { get; init; }
    public string ExecutionAccount { get; init; } = string.Empty;
    /// <summary>Consecutive failed gateway calls since the last success.</summary>
    public int ConnectionFailures { get; init; }
    /// <summary>Reconnect attempts since the last successful heartbeat.</summary>
    public int ReconnectAttempts { get; init; }
    /// <summary>The agent requires a service restart to apply an upgrade/config.</summary>
    public bool RestartRequired { get; init; }
}

public sealed class AuthResult
{
    public bool Success { get; init; }
    public int StatusCode { get; init; }
    /// <summary>The device credentials were rejected (401).</summary>
    public bool Unauthorized { get; init; }
    /// <summary>Authenticated, but the device is not authorized (pending), suspended or revoked.</summary>
    public bool NotAuthorized { get; init; }
    public bool Revoked { get; init; }
    public string? Error { get; init; }
}

public sealed class EnrollmentResponse
{
    public bool Success { get; init; }
    public Guid? DeviceId { get; init; }
    public Guid? OrganizationId { get; init; }
    public string? EnrollmentStatus { get; init; }
    public string? ApiKey { get; init; }
    public int StatusCode { get; init; }
    public string? Error { get; init; }
    public bool PermanentlyRejected { get; init; }
}

public sealed class HeartbeatResult
{
    public bool Success { get; init; }
    public string EnrollmentStatus { get; init; } = "unknown";
    public int PendingJobsCount { get; init; }
    public int PendingDeployments { get; init; }
    public int OfflineAfterSeconds { get; init; } = 300;
    public AgentRmmSettings? RmmSettings { get; init; }
    public bool Revoked { get; init; }
    public bool NotAuthorized { get; init; }
    public string? Error { get; init; }
}

/// <summary>Shared runtime counters for heartbeat reporting.</summary>
public sealed class AgentRuntimeState
{
    private int _connectionFailures;
    private int _reconnectAttempts;

    public int ConnectionFailures => Volatile.Read(ref _connectionFailures);
    public int ReconnectAttempts => Volatile.Read(ref _reconnectAttempts);
    public bool RestartRequired { get; set; }

    public void RecordFailure()
    {
        Interlocked.Increment(ref _connectionFailures);
        Interlocked.Increment(ref _reconnectAttempts);
    }

    public void RecordSuccess()
    {
        Interlocked.Exchange(ref _connectionFailures, 0);
        Interlocked.Exchange(ref _reconnectAttempts, 0);
    }
}

public sealed class TerminalClaimResult
{
    [JsonPropertyName("session_id")]
    public Guid SessionId { get; set; }

    [JsonPropertyName("expires_at")]
    public DateTimeOffset ExpiresAt { get; set; }

    [JsonPropertyName("last_output_sequence")]
    public long LastOutputSequence { get; set; }

    [JsonPropertyName("hostname")]
    public string Hostname { get; set; } = string.Empty;
}

public sealed class TerminalCommandItem
{
    [JsonPropertyName("command_id")]
    public Guid CommandId { get; set; }

    [JsonPropertyName("sequence")]
    public long Sequence { get; set; }

    [JsonPropertyName("command")]
    public string Command { get; set; } = string.Empty;
}

public sealed class TerminalPollResult
{
    public bool Success { get; init; }
    public string SessionStatus { get; init; } = "invalid";
    public string? CloseReason { get; init; }
    public List<TerminalCommandItem> Commands { get; init; } = new();
    public string? Error { get; init; }

    public bool SessionEnded =>
        !string.Equals(SessionStatus, "active", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(SessionStatus, "pending", StringComparison.OrdinalIgnoreCase);
}

public sealed class TerminalOutputChunk
{
    public string Stream { get; init; } = "stdout";
    public string Content { get; init; } = string.Empty;
}

public sealed class TerminalOutputAck
{
    public bool Success { get; init; }
    public string SessionStatus { get; init; } = "active";
    public long LastOutputSequence { get; init; }
    public bool SessionEnded =>
        !string.Equals(SessionStatus, "active", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(SessionStatus, "pending", StringComparison.OrdinalIgnoreCase);
}

public sealed class TerminalSessionState
{
    public string Status { get; init; } = "invalid";
    public string? Reason { get; init; }

    public bool Ended =>
        !string.Equals(Status, "active", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(Status, "pending", StringComparison.OrdinalIgnoreCase);
}

public sealed class TerminalCommandOutcome
{
    public bool ExitOk { get; init; }
    public bool TimedOut { get; init; }
    public bool SessionLost { get; init; }
    public string? Error { get; init; }
    public bool Truncated { get; init; }
    public bool AccessDeniedHint { get; init; }
    public bool InteractiveRejected { get; init; }
}
