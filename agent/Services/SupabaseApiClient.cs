using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Linq;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

/// <summary>
/// Agent-side transport.
///
/// All calls go through Supabase Edge Functions:
///  * device-auth    – exchanges the per-device API key for a short-lived device JWT
///  * enroll-device  – zero-touch registration with the organization enrollment key
///  * agent-gateway  – authenticated jobs + terminal transport (device JWT verified
///                     inside the function; the agent holds no service-role key)
///
/// Direct PostgREST access was removed because a device JWT signed with the
/// platform device secret is not a Supabase project JWT and was rejected by the
/// API gateway. Routing through the gateway also gives immediate revocation
/// enforcement: the device lifecycle state is re-checked on every request.
/// </summary>
public class SupabaseApiClient : ISupabaseApiClient
{
    private readonly HttpClient _httpClient;
    private readonly AgentOptions _options;
    private readonly ILogger<SupabaseApiClient> _logger;

    private string? _cachedJwt;
    private DateTimeOffset _jwtExpiresAt = DateTimeOffset.MinValue;
    private readonly SemaphoreSlim _authLock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    /// <summary>Wire format for agent → gateway payloads (snake_case, no nulls).</summary>
    private static readonly JsonSerializerOptions GatewayJson = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public SupabaseApiClient(
        HttpClient httpClient,
        IOptions<AgentOptions> options,
        ILogger<SupabaseApiClient> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_options.SupabaseUrl)
            || !Uri.TryCreate(_options.SupabaseUrl, UriKind.Absolute, out var baseUri))
        {
            throw new InvalidOperationException(
                "ScriptRunner:SupabaseUrl must be configured. The agent will not start without an explicit backend URL.");
        }
        _httpClient.BaseAddress = new Uri(baseUri.ToString().TrimEnd('/') + "/");

        if (string.IsNullOrWhiteSpace(_options.SupabaseAnonKey))
        {
            throw new InvalidOperationException(
                "ScriptRunner:SupabaseAnonKey must be configured. The agent never ships with a service-role credential.");
        }
        _httpClient.DefaultRequestHeaders.Add("apikey", _options.SupabaseAnonKey);
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _options.SupabaseAnonKey);

        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        _httpClient.Timeout = TimeSpan.FromSeconds(90);
    }

    // ------------------------------------------------------------------
    // Authentication & enrollment
    // ------------------------------------------------------------------

    public async Task<AuthResult> AuthenticateAsync(CancellationToken cancellationToken)
    {
        await _authLock.WaitAsync(cancellationToken);
        try
        {
            if (!string.IsNullOrEmpty(_cachedJwt) && DateTimeOffset.UtcNow.AddMinutes(5) < _jwtExpiresAt)
            {
                return new AuthResult { Success = true, StatusCode = 200 };
            }

            if (string.IsNullOrWhiteSpace(_options.DeviceId) ||
                string.IsNullOrWhiteSpace(_options.DeviceApiKey) ||
                !Guid.TryParse(_options.DeviceId, out _))
            {
                return new AuthResult
                {
                    Success = false,
                    StatusCode = 0,
                    Unauthorized = true,
                    Error = "No device credential is available yet"
                };
            }

            _logger.LogInformation("Authenticating device {DeviceId}...", _options.DeviceId);

            var request = new HttpRequestMessage(HttpMethod.Post, "functions/v1/device-auth")
            {
                Content = JsonContent.Create(new
                {
                    device_id = _options.DeviceId,
                    api_key = _options.DeviceApiKey,
                    agent_version = "1.0.0"
                })
            };

            using var response = await _httpClient.SendAsync(request, cancellationToken);
            string body = await response.Content.ReadAsStringAsync(cancellationToken);

            // A missing device-auth function is a deployment error. Falling back
            // to direct database access would bypass device identity entirely.
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return new AuthResult
                {
                    Success = false,
                    StatusCode = 404,
                    Error = "device-auth function is not deployed for this backend"
                };
            }

            if (!response.IsSuccessStatusCode)
            {
                bool revoked = body.Contains("revoked", StringComparison.OrdinalIgnoreCase);
                bool notEnrolled = body.Contains("not enrolled", StringComparison.OrdinalIgnoreCase);

                _logger.LogWarning(
                    "Device authentication rejected with HTTP {StatusCode}: {Error}",
                    (int)response.StatusCode, Truncate(body, 200));

                return new AuthResult
                {
                    Success = false,
                    StatusCode = (int)response.StatusCode,
                    Unauthorized = response.StatusCode == HttpStatusCode.Unauthorized,
                    // 403 means the credential is valid but the device lifecycle
                    // state forbids access (pending authorization / suspended /
                    // revoked). Re-enrolling would rotate keys without fixing that.
                    NotAuthorized = response.StatusCode == HttpStatusCode.Forbidden || notEnrolled,
                    Revoked = revoked,
                    Error = Truncate(body, 200)
                };
            }

            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("access_token", out var tokenProp))
            {
                _cachedJwt = tokenProp.GetString();
                int expiresIn = doc.RootElement.TryGetProperty("expires_in", out var expProp)
                    ? expProp.GetInt32()
                    : 3600;
                _jwtExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);
                _logger.LogInformation("Device authenticated. Token valid until {ExpiresAt:u}", _jwtExpiresAt);
                return new AuthResult { Success = true, StatusCode = 200 };
            }

            return new AuthResult
            {
                Success = false,
                StatusCode = (int)response.StatusCode,
                Unauthorized = true,
                Error = "Authentication response did not contain a token"
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Device authentication failed (network): {Message}", ex.Message);
            return new AuthResult { Success = false, Error = ex.Message };
        }
        finally
        {
            _authLock.Release();
        }
    }

    public async Task<EnrollmentResponse> EnrollAsync(DeviceIdentity identity, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_options.EnrollmentKey)
            || _options.EnrollmentKey.StartsWith("REPLACE", StringComparison.OrdinalIgnoreCase))
        {
            // Fail closed: a device cannot enroll itself by writing to the
            // devices table. Enrollment requires an organisation key issued by
            // an administrator.
            return new EnrollmentResponse
            {
                Success = false,
                StatusCode = 0,
                Error = "No organization enrollment key is configured for this agent."
            };
        }

        try
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "functions/v1/enroll-device")
            {
                Content = JsonContent.Create(new
                {
                    enrollment_key = _options.EnrollmentKey,
                    install_id = identity.InstallId,
                    device_id = identity.DeviceId,
                    hostname = Environment.MachineName,
                    operating_system = OperatingSystemInfo.Describe(),
                    agent_version = "1.0.0"
                })
            };

            using var response = await _httpClient.SendAsync(request, cancellationToken);
            string body = await response.Content.ReadAsStringAsync(cancellationToken);

            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return new EnrollmentResponse
                {
                    Success = false,
                    StatusCode = 404,
                    Error = "enroll-device function is not deployed for this backend"
                };
            }

            if (!response.IsSuccessStatusCode)
            {
                bool permanent = response.StatusCode is HttpStatusCode.Unauthorized
                    or HttpStatusCode.Forbidden
                    or HttpStatusCode.Conflict;

                _logger.LogWarning(
                    "Enrollment attempt rejected with HTTP {StatusCode}: {Error}",
                    (int)response.StatusCode, Truncate(body, 200));

                return new EnrollmentResponse
                {
                    Success = false,
                    StatusCode = (int)response.StatusCode,
                    PermanentlyRejected = permanent,
                    Error = Truncate(body, 200)
                };
            }

            var parsed = JsonSerializer.Deserialize<EnrollmentResponseDto>(body, JsonOpts);
            if (parsed?.DeviceId is null || string.IsNullOrEmpty(parsed.ApiKey))
            {
                return new EnrollmentResponse
                {
                    Success = false,
                    StatusCode = (int)response.StatusCode,
                    Error = "Enrollment response was incomplete"
                };
            }

            _logger.LogInformation(
                "Device enrolled. Device ID: {DeviceId}, status: {Status}",
                parsed.DeviceId, parsed.EnrollmentStatus);

            return new EnrollmentResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                DeviceId = parsed.DeviceId,
                OrganizationId = parsed.OrganizationId,
                EnrollmentStatus = parsed.EnrollmentStatus,
                ApiKey = parsed.ApiKey
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Enrollment request failed (network): {Message}", ex.Message);
            return new EnrollmentResponse { Success = false, Error = ex.Message };
        }
    }

    // ------------------------------------------------------------------
    // Gateway transport
    // ------------------------------------------------------------------

    private async Task EnsureTokenAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(_cachedJwt) || DateTimeOffset.UtcNow.AddMinutes(2) >= _jwtExpiresAt)
        {
            await AuthenticateAsync(cancellationToken);
        }
    }

    private async Task<GatewayResponse> SendGatewayAsync(
        string action,
        object? payload,
        CancellationToken cancellationToken,
        bool retryOnUnauthorized = true)
    {
        await EnsureTokenAsync(cancellationToken);

        if (string.IsNullOrEmpty(_cachedJwt))
        {
            return GatewayResponse.NotAuthorized("No device token");
        }

        var body = new Dictionary<string, object?> { ["action"] = action };

        if (payload is not null)
        {
            foreach (var property in JsonSerializer.SerializeToNode(payload, GatewayJson)!.AsObject())
            {
                body[property.Key] = property.Value;
            }
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, "functions/v1/agent-gateway")
        {
            Content = JsonContent.Create(body)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _cachedJwt);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        string text = await response.Content.ReadAsStringAsync(cancellationToken);

        if (response.StatusCode == HttpStatusCode.Unauthorized && retryOnUnauthorized)
        {
            // Token expired or device credential rotated: re-authenticate once.
            _cachedJwt = null;
            _jwtExpiresAt = DateTimeOffset.MinValue;
            return await SendGatewayAsync(action, payload, cancellationToken, retryOnUnauthorized: false);
        }

        if (!response.IsSuccessStatusCode)
        {
            string? code = null, enrollmentStatus = null;
            try
            {
                using var errDoc = JsonDocument.Parse(text);
                if (errDoc.RootElement.TryGetProperty("code", out var c)) code = c.GetString();
                if (errDoc.RootElement.TryGetProperty("enrollment_status", out var s)) enrollmentStatus = s.GetString();
            }
            catch { /* non-JSON error body */ }

            return GatewayResponse.Failure((int)response.StatusCode, code ?? text, enrollmentStatus);
        }

        return GatewayResponse.Ok(text);
    }

    public async Task<HeartbeatResult> SendHeartbeatAsync(AgentTelemetry telemetry, CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("heartbeat", new
            {
                hostname = telemetry.Hostname,
                operating_system = telemetry.OperatingSystem,
                agent_version = telemetry.AgentVersion,
                service_status = telemetry.ServiceStatus,
                is_elevated = telemetry.IsElevated,
                execution_account = telemetry.ExecutionAccount,
                connection_failures = telemetry.ConnectionFailures,
                reconnect_attempts = telemetry.ReconnectAttempts,
                restart_required = telemetry.RestartRequired
            }, cancellationToken);

            if (!response.Success)
            {
                return new HeartbeatResult
                {
                    Success = false,
                    Revoked = response.EnrollmentStatus == "revoked",
                    NotAuthorized = response.EnrollmentStatus is "unauthorized" or "suspended",
                    EnrollmentStatus = response.EnrollmentStatus ?? "unknown",
                    Error = response.Error
                };
            }

            var dto = JsonSerializer.Deserialize<HeartbeatDto>(response.Body!, JsonOpts);
            return new HeartbeatResult
            {
                Success = true,
                EnrollmentStatus = dto?.EnrollmentStatus ?? "enrolled",
                PendingJobsCount = dto?.PendingJobsCount ?? 0,
                PendingDeployments = dto?.PendingDeployments ?? 0,
                OfflineAfterSeconds = dto?.OfflineAfterSeconds ?? 300,
                RmmSettings = dto?.Settings
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to send heartbeat: {Message}", ex.Message);
            return new HeartbeatResult { Success = false, Error = ex.Message };
        }
    }

    // ------------------------------------------------------------------
    // RMM: inventory, telemetry, monitors and deployments
    // ------------------------------------------------------------------

    public async Task<AgentRmmConfig?> GetAgentConfigAsync(CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayWithRetryAsync("agent_config", null, cancellationToken);
            if (!response.Success)
            {
                _logger.LogWarning("Agent configuration fetch failed: {Error}", response.Error);
                return null;
            }

            return JsonSerializer.Deserialize<AgentRmmConfig>(response.Body!, JsonOpts);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Agent configuration fetch failed: {Message}", ex.Message);
            return null;
        }
    }

    public async Task<bool> SendInventoryAsync(
        HardwareInventory hardware,
        OperatingSystemInventory os,
        NetworkInventory network,
        IReadOnlyList<string> dataQuality,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayWithRetryAsync("ingest_inventory", new
        {
            hardware,
            os,
            network,
            data_quality = dataQuality,
            collected_at = collectedAt.ToString("o")
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Inventory upload failed: {Error}", response.Error);
        }
        return response.Success;
    }

    public async Task<bool> SendMetricsAsync(
        IReadOnlyList<MetricSample> samples,
        CancellationToken cancellationToken)
    {
        if (samples.Count == 0) return true;

        var response = await SendGatewayWithRetryAsync("ingest_metrics", new
        {
            samples = samples.Take(500).ToArray()
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Metric upload failed: {Error}", response.Error);
        }
        return response.Success;
    }

    public async Task<bool> SendSoftwareInventoryAsync(
        IReadOnlyList<SoftwareApplication> applications,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayWithRetryAsync("ingest_software", new
        {
            applications = applications.Take(3000).ToArray(),
            collected_at = collectedAt.ToString("o")
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Software inventory upload failed: {Error}", response.Error);
        }
        return response.Success;
    }

    public async Task<bool> SendEventsAsync(
        IReadOnlyList<EventLogEntryDto> events,
        CancellationToken cancellationToken)
    {
        if (events.Count == 0) return true;

        var response = await SendGatewayWithRetryAsync("ingest_events", new
        {
            events = events.Take(200).ToArray()
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Event log upload failed: {Error}", response.Error);
        }
        return response.Success;
    }

    public async Task<bool> ReportMonitorResultAsync(
        Guid monitorId,
        MonitorOutcome outcome,
        DateTimeOffset observedAt,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayWithRetryAsync("monitor_result", new
        {
            monitor_id = monitorId,
            status = outcome.Status,
            value = outcome.Value,
            message = outcome.Message,
            details = outcome.Details,
            duration_ms = outcome.DurationMs,
            error = outcome.Error,
            observed_at = observedAt.ToString("o"),
            recovery_performed = outcome.RecoveryPerformed,
            recovery_note = outcome.RecoveryNote
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Monitor result upload failed: {Error}", response.Error);
        }
        return response.Success;
    }

    public async Task<DeploymentWorkItem?> ClaimDeploymentAsync(CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayWithRetryAsync("claim_deployment", null, cancellationToken);
            if (!response.Success)
            {
                _logger.LogWarning("Deployment claim failed: {Error}", response.Error);
                return null;
            }

            var envelope = JsonSerializer.Deserialize<DeploymentClaimEnvelope>(response.Body!, JsonOpts);
            return envelope?.Job;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Deployment claim failed: {Message}", ex.Message);
            return null;
        }
    }

    public async Task<bool> UpdateDeploymentAsync(
        Guid jobId,
        string state,
        int? progress,
        int? exitCode,
        string? output,
        string? error,
        bool? rebootRequired,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayWithRetryAsync("deployment_update", new
        {
            job_id = jobId,
            state,
            progress,
            exit_code = exitCode,
            output,
            error,
            reboot_required = rebootRequired
        }, cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Deployment update failed: {Error}", response.Error);
        }
        return response.Success;
    }

    private async Task<GatewayResponse> SendGatewayWithRetryAsync(
        string action,
        object? payload,
        CancellationToken cancellationToken,
        int attempts = 3)
    {
        GatewayResponse response = GatewayResponse.NotAuthorized("not attempted");

        for (var attempt = 1; attempt <= attempts; attempt++)
        {
            try
            {
                response = await SendGatewayAsync(action, payload, cancellationToken);
                if (response.Success) return response;

                // Authentication/authorization failures are not retried.
                if (response.StatusCode is 401 or 403) return response;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                response = GatewayResponse.Failure(0, ex.Message, null);
            }

            if (attempt < attempts)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt - 1)), cancellationToken);
            }
        }

        return response;
    }

    // ------------------------------------------------------------------
    // Script jobs
    // ------------------------------------------------------------------

    public async Task<List<PendingJobItem>> GetPendingJobsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("pending_jobs", null, cancellationToken);
            if (!response.Success)
            {
                _logger.LogWarning("GetPendingJobs failed: {Error}", response.Error);
                return new List<PendingJobItem>();
            }

            var dto = JsonSerializer.Deserialize<JobsEnvelope>(response.Body!, JsonOpts);
            return dto?.Jobs ?? new List<PendingJobItem>();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve pending jobs");
            return new List<PendingJobItem>();
        }
    }

    public async Task<ClaimJobResponse> ClaimJobAsync(Guid jobId, CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("claim_job", new { job_id = jobId }, cancellationToken);
            if (!response.Success)
            {
                return new ClaimJobResponse { Success = false, Error = response.Error };
            }

            var dto = JsonSerializer.Deserialize<ClaimedJobEnvelope>(response.Body!, JsonOpts);
            var job = dto?.Job;

            if (job is null)
            {
                return new ClaimJobResponse
                {
                    Success = false,
                    Error = "Job could not be claimed (already claimed, expired, or cancelled)"
                };
            }

            return new ClaimJobResponse
            {
                Success = true,
                JobId = job.Id,
                ScriptContent = job.ScriptContent,
                ScriptHash = job.ScriptHash,
                TimeoutSeconds = job.TimeoutSeconds,
                AttemptNumber = 1
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to claim job {JobId}", jobId);
            return new ClaimJobResponse { Success = false, Error = ex.Message };
        }
    }

    public async Task<bool> MarkJobRunningAsync(
        Guid jobId,
        int attemptNumber,
        string agentExecutionId,
        DateTimeOffset startedAt,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("mark_running", new
            {
                job_id = jobId,
                attempt_number = attemptNumber,
                agent_execution_id = agentExecutionId,
                started_at = startedAt.ToString("o")
            }, cancellationToken);

            return response.Success;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to mark job {JobId} as running", jobId);
            return false;
        }
    }

    public async Task<bool> ReportJobCompletionAsync(
        ReportCompletionRequest request,
        CancellationToken cancellationToken)
    {
        int maxRetries = 5;
        int delayMs = 1000;

        for (int attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                var response = await SendGatewayAsync("report_completion", new
                {
                    job_id = request.JobId,
                    attempt_number = request.AttemptNumber,
                    agent_execution_id = request.AgentExecutionId,
                    outcome = request.Outcome,
                    exit_code = request.ExitCode ?? -1,
                    stdout = request.Stdout ?? string.Empty,
                    stdout_truncated = request.StdoutTruncated,
                    stderr = request.Stderr ?? string.Empty,
                    stderr_truncated = request.StderrTruncated,
                    error_summary = request.ErrorSummary
                }, cancellationToken);

                if (response.Success)
                {
                    _logger.LogInformation(
                        "Job {JobId} completion reported successfully (Outcome: {Outcome})",
                        request.JobId, request.Outcome);
                    return true;
                }

                _logger.LogWarning("Report completion attempt {Attempt} failed: {Error}",
                    attempt, response.Error);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (attempt < maxRetries)
            {
                _logger.LogWarning(ex, "Transient failure reporting job completion (Attempt {Attempt}/{Max})",
                    attempt, maxRetries);
            }

            await Task.Delay(delayMs, cancellationToken);
            delayMs = Math.Min(delayMs * 2, 10000);
        }

        _logger.LogError("Failed to report completion for job {JobId} after {MaxRetries} retries",
            request.JobId, maxRetries);
        return false;
    }

    public async Task<List<LocalExecutionState>> GetAmbiguousJobsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("ambiguous_jobs", null, cancellationToken);
            if (!response.Success) return new List<LocalExecutionState>();

            var dto = JsonSerializer.Deserialize<AmbiguousEnvelope>(response.Body!, JsonOpts);
            return (dto?.Jobs ?? new List<AmbiguousJobDto>())
                .Where(j => j.JobId != Guid.Empty)
                .Select(j => new LocalExecutionState
                {
                    JobId = j.JobId,
                    AttemptNumber = 1,
                    StartedAt = DateTimeOffset.UtcNow
                })
                .ToList();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking ambiguous jobs");
            return new List<LocalExecutionState>();
        }
    }

    // ------------------------------------------------------------------
    // Terminal transport
    // ------------------------------------------------------------------

    public async Task<TerminalClaimResult?> ClaimTerminalSessionAsync(
        string agentInstanceId,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayAsync("terminal_claim", new
        {
            agent_instance = agentInstanceId
        }, cancellationToken);

        if (!response.Success)
        {
            if (response.StatusCode == 403)
            {
                throw new DeviceNotAuthorizedException(response.EnrollmentStatus ?? "unknown", response.Error);
            }
            return null;
        }

        var dto = JsonSerializer.Deserialize<TerminalClaimEnvelope>(response.Body!, JsonOpts);
        return dto?.Session;
    }

    public async Task<TerminalPollResult> PollTerminalCommandsAsync(
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("terminal_poll", new
            {
                session_id = sessionId
            }, cancellationToken);

            if (!response.Success)
            {
                return new TerminalPollResult
                {
                    Success = false,
                    SessionStatus = response.StatusCode == 403 ? "revoked" : "invalid",
                    CloseReason = response.EnrollmentStatus == "revoked"
                        ? "Device access revoked"
                        : response.Error,
                    Error = response.Error
                };
            }

            var dto = JsonSerializer.Deserialize<TerminalPollDto>(response.Body!, JsonOpts);
            return new TerminalPollResult
            {
                Success = true,
                SessionStatus = dto?.SessionStatus ?? "invalid",
                CloseReason = dto?.CloseReason,
                Commands = dto?.Commands ?? new List<TerminalCommandItem>()
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Terminal poll failed: {Message}", ex.Message);
            return new TerminalPollResult
            {
                Success = false,
                SessionStatus = "active", // transient: the worker retries / reconnects
                Error = ex.Message
            };
        }
    }

    public async Task<TerminalOutputAck?> SendTerminalOutputAsync(
        Guid sessionId,
        IReadOnlyList<TerminalOutputChunk> chunks,
        CancellationToken cancellationToken)
    {
        if (chunks.Count == 0) return null;

        var response = await SendGatewayAsync("terminal_output", new
        {
            session_id = sessionId,
            items = chunks.Select(c => new { stream = c.Stream, content = c.Content }).ToArray()
        }, cancellationToken);

        if (!response.Success)
        {
            if (response.StatusCode == 403)
            {
                throw new DeviceNotAuthorizedException(response.EnrollmentStatus ?? "unknown", response.Error);
            }
            return null;
        }

        var dto = JsonSerializer.Deserialize<TerminalOutputDto>(response.Body!, JsonOpts);
        return new TerminalOutputAck
        {
            Success = true,
            SessionStatus = dto?.SessionStatus ?? "active",
            LastOutputSequence = dto?.LastOutputSequence ?? 0
        };
    }

    public async Task<TerminalSessionState> GetTerminalSessionStateAsync(
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("terminal_state", new
            {
                session_id = sessionId
            }, cancellationToken);

            if (!response.Success)
            {
                return new TerminalSessionState
                {
                    Status = response.StatusCode == 403 ? "revoked" : "invalid",
                    Reason = response.Error
                };
            }

            var dto = JsonSerializer.Deserialize<TerminalStateDto>(response.Body!, JsonOpts);
            return new TerminalSessionState
            {
                Status = dto?.SessionStatus ?? "invalid",
                Reason = dto?.CloseReason
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Transport failure: treat as "still active" and let the caller retry;
            // only an explicit server status ends the session.
            return new TerminalSessionState { Status = "active", Reason = ex.Message };
        }
    }

    public async Task<bool> ReportTerminalCommandResultAsync(
        Guid sessionId,
        long sequence,
        bool exitOk,
        string? error,
        CancellationToken cancellationToken)
    {
        var response = await SendGatewayAsync("terminal_command_result", new
        {
            session_id = sessionId,
            sequence,
            exit_ok = exitOk,
            error
        }, cancellationToken);

        return response.Success;
    }

    public async Task<bool> EndTerminalSessionAsync(
        Guid sessionId,
        string reason,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await SendGatewayAsync("terminal_end", new
            {
                session_id = sessionId,
                reason
            }, cancellationToken);
            return response.Success;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to end terminal session {SessionId}: {Message}", sessionId, ex.Message);
            return false;
        }
    }

    private static string Truncate(string text, int max) =>
        string.IsNullOrEmpty(text) ? string.Empty : (text.Length <= max ? text : text[..max]);

    // ------------------------------------------------------------------
    // Gateway DTOs / envelope handling
    // ------------------------------------------------------------------

    private sealed class GatewayResponse
    {
        public bool Success { get; init; }
        public int StatusCode { get; init; }
        public string? Body { get; init; }
        public string? Error { get; init; }
        public string? EnrollmentStatus { get; init; }
        public string? Code { get; init; }

        public static GatewayResponse Ok(string body) => new() { Success = true, StatusCode = 200, Body = body };
        public static GatewayResponse NotAuthorized(string error) =>
            new() { Success = false, StatusCode = 401, Error = error };
        public static GatewayResponse Failure(int status, string error, string? enrollmentStatus) =>
            new() { Success = false, StatusCode = status, Error = error, EnrollmentStatus = enrollmentStatus };
    }

    private sealed class EnrollmentResponseDto
    {
        [JsonPropertyName("device_id")] public Guid? DeviceId { get; set; }
        [JsonPropertyName("organization_id")] public Guid? OrganizationId { get; set; }
        [JsonPropertyName("enrollment_status")] public string? EnrollmentStatus { get; set; }
        [JsonPropertyName("api_key")] public string? ApiKey { get; set; }
    }

    private sealed class HeartbeatDto
    {
        [JsonPropertyName("enrollment_status")] public string? EnrollmentStatus { get; set; }
        [JsonPropertyName("pending_jobs_count")] public int PendingJobsCount { get; set; }
        [JsonPropertyName("pending_deployments")] public int PendingDeployments { get; set; }
        [JsonPropertyName("offline_after_seconds")] public int OfflineAfterSeconds { get; set; } = 300;
        [JsonPropertyName("settings")] public AgentRmmSettings? Settings { get; set; }
    }

    private sealed class DeploymentClaimEnvelope
    {
        [JsonPropertyName("job")] public DeploymentWorkItem? Job { get; set; }
    }

    private sealed class JobsEnvelope
    {
        [JsonPropertyName("jobs")] public List<PendingJobItem>? Jobs { get; set; }
    }

    private sealed class ClaimedJobDto
    {
        [JsonPropertyName("id")] public Guid Id { get; set; }
        [JsonPropertyName("script_content")] public string? ScriptContent { get; set; }
        [JsonPropertyName("script_hash")] public string? ScriptHash { get; set; }
        [JsonPropertyName("timeout_seconds")] public int TimeoutSeconds { get; set; } = 300;
    }

    private sealed class ClaimedJobEnvelope
    {
        [JsonPropertyName("job")] public ClaimedJobDto? Job { get; set; }
    }

    private sealed class AmbiguousJobDto
    {
        [JsonPropertyName("job_id")] public Guid JobId { get; set; }
    }

    private sealed class AmbiguousEnvelope
    {
        [JsonPropertyName("jobs")] public List<AmbiguousJobDto>? Jobs { get; set; }
    }

    private sealed class TerminalClaimEnvelope
    {
        [JsonPropertyName("session")] public TerminalClaimResult? Session { get; set; }
    }

    private sealed class TerminalPollDto
    {
        [JsonPropertyName("session_status")] public string? SessionStatus { get; set; }
        [JsonPropertyName("close_reason")] public string? CloseReason { get; set; }
        [JsonPropertyName("commands")] public List<TerminalCommandItem>? Commands { get; set; }
    }

    private sealed class TerminalOutputDto
    {
        [JsonPropertyName("session_status")] public string? SessionStatus { get; set; }
        [JsonPropertyName("last_output_sequence")] public long LastOutputSequence { get; set; }
    }

    private sealed class TerminalStateDto
    {
        [JsonPropertyName("session_status")] public string? SessionStatus { get; set; }
        [JsonPropertyName("close_reason")] public string? CloseReason { get; set; }
    }
}

public sealed class DeviceNotAuthorizedException : Exception
{
    public DeviceNotAuthorizedException(string enrollmentStatus, string? error)
        : base($"Device is not authorized ({enrollmentStatus}){(error is null ? "" : $": {error}")}")
    {
        EnrollmentStatus = enrollmentStatus;
    }

    public string EnrollmentStatus { get; }
}

public static class OperatingSystemInfo
{
    public static string Describe()
    {
        try
        {
            return System.Runtime.InteropServices.RuntimeInformation.OSDescription.Trim();
        }
        catch
        {
            return Environment.OSVersion.ToString();
        }
    }
}
