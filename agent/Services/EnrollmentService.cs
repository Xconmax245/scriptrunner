using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Services;

/// <summary>
/// Owns the device's automatic enrollment lifecycle.
///
/// The installation is considered complete locally as soon as the service runs;
/// enrollment retries in the background when the network (or the backend) is
/// temporarily unreachable. The agent never requires an operator to type a device
/// ID or paste a per-device invitation token.
/// </summary>
public sealed class EnrollmentService
{
    private readonly ISupabaseApiClient _apiClient;
    private readonly IDeviceIdentityStore _identityStore;
    private readonly AgentOptions _options;
    private readonly ILogger<EnrollmentService> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _statusFilePath;

    private DeviceIdentity? _identity;
    private AgentAuthorizationState _state = AgentAuthorizationState.Unknown;
    private string? _lastError;
    private DateTimeOffset _lastAttemptAt = DateTimeOffset.MinValue;

    public EnrollmentService(
        ISupabaseApiClient apiClient,
        IDeviceIdentityStore identityStore,
        IOptions<AgentOptions> options,
        ILogger<EnrollmentService> logger)
    {
        _apiClient = apiClient;
        _identityStore = identityStore;
        _options = options.Value;
        _logger = logger;

        // Make the locally generated identity available to the HTTP client before
        // the first request, so the installer never has to supply it.
        var identity = _identityStore.LoadOrCreate();
        ApplyIdentity(identity);

        string stateDir = Path.GetDirectoryName(_identityStore.IdentityFilePath)
            ?? AppContext.BaseDirectory;
        _statusFilePath = Path.Combine(stateDir, "enrollment-status.json");
        WriteStatusFile();
    }

    public AgentAuthorizationState State => _state;
    public string? LastError => _lastError;
    public Guid DeviceId => _identity?.DeviceId ?? Guid.Empty;
    public Guid InstallId => _identity?.InstallId ?? Guid.Empty;

    /// <summary>Minimum time between authorization attempts.</summary>
    public TimeSpan RetryInterval =>
        _state == AgentAuthorizationState.AwaitingAuthorization
            ? TimeSpan.FromSeconds(30)
            : TimeSpan.FromSeconds(15);

    /// <summary>
    /// Ensures the device holds a valid, authorized credential. Safe to call
    /// repeatedly; retries transient failures and remains pending until an
    /// administrator authorizes an `unauthorized` device.
    /// </summary>
    public async Task<bool> EnsureAuthorizedAsync(CancellationToken cancellationToken)
    {
        if (_state == AgentAuthorizationState.Authorized) return true;
        if (_state == AgentAuthorizationState.Revoked) return false;
        if (_state == AgentAuthorizationState.Suspended) return false;

        if (DateTimeOffset.UtcNow - _lastAttemptAt < RetryInterval)
        {
            return false;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_state == AgentAuthorizationState.Authorized) return true;
            if (DateTimeOffset.UtcNow - _lastAttemptAt < RetryInterval) return false;
            _lastAttemptAt = DateTimeOffset.UtcNow;

            var identity = _identity ??= _identityStore.LoadOrCreate();
            ApplyIdentity(identity);

            // 1. Try the existing device credential first (normal path).
            if (!string.IsNullOrEmpty(identity.ApiKey))
            {
                var auth = await _apiClient.AuthenticateAsync(cancellationToken);

                if (auth.Success)
                {
                    SetState(AgentAuthorizationState.Authorized, null);
                    _logger.LogInformation("Device {DeviceId} is authorized and online.", identity.DeviceId);
                    return true;
                }

                if (auth.Revoked)
                {
                    SetState(AgentAuthorizationState.Revoked, auth.Error);
                    _logger.LogError(
                        "Device {DeviceId} has been revoked by an administrator. Remote commands and terminal sessions are refused.",
                        identity.DeviceId);
                    return false;
                }

                if (auth.NotAuthorized)
                {
                    // Authenticated but not permitted yet (pending/suspended): do
                    // not re-enroll, surface the state and retry later.
                    SetState(AgentAuthorizationState.AwaitingAuthorization, auth.Error);
                    _logger.LogWarning(
                        "Device {DeviceId} is registered but not authorized yet ({Error}). Waiting for an administrator.",
                        identity.DeviceId, auth.Error);
                    return false;
                }

                if (auth.StatusCode is > 0 and not 401)
                {
                    SetState(AgentAuthorizationState.Enrolling, auth.Error);
                    _logger.LogWarning("Device authentication returned HTTP {Status}: {Error}",
                        auth.StatusCode, auth.Error);
                    return false;
                }

                _logger.LogWarning(
                    "Existing device credential was rejected ({Error}); re-enrolling with the organization key.",
                    auth.Error);
            }

            // 2. Enroll with the organization enrollment key.
            SetState(AgentAuthorizationState.Enrolling, null);
            var enrollment = await _apiClient.EnrollAsync(identity, cancellationToken);

            if (!enrollment.Success)
            {
                SetState(AgentAuthorizationState.Enrolling, enrollment.Error);
                _logger.LogWarning(
                    "Enrollment attempt failed: {Error}. Retrying in the background.",
                    enrollment.Error);
                return false;
            }

            identity.ApiKey = enrollment.ApiKey;
            identity.OrganizationId = enrollment.OrganizationId;
            identity.EnrollmentStatus = enrollment.EnrollmentStatus;
            identity.EnrolledAt = DateTimeOffset.UtcNow;
            await _identityStore.SaveAsync(identity, cancellationToken);
            ApplyIdentity(identity);

            if (string.Equals(enrollment.EnrollmentStatus, "enrolled", StringComparison.OrdinalIgnoreCase))
            {
                SetState(AgentAuthorizationState.Authorized, null);
                _logger.LogInformation(
                    "Enrollment successful. Device {DeviceId} is authorized by organization policy.",
                    identity.DeviceId);
                return true;
            }

            SetState(AgentAuthorizationState.AwaitingAuthorization, enrollment.EnrollmentStatus);
            _logger.LogWarning(
                "Device {DeviceId} enrolled and is awaiting administrator authorization. It cannot receive commands until authorized.",
                identity.DeviceId);
            return false;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            _logger.LogWarning(ex, "Enrollment attempt failed unexpectedly; will retry.");
            return false;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Called when a gateway call reports that access was revoked or suspended.</summary>
    public void MarkNotAuthorized(string? enrollmentStatus, string? error)
    {
        var state = enrollmentStatus switch
        {
            "revoked" => AgentAuthorizationState.Revoked,
            "suspended" => AgentAuthorizationState.Suspended,
            "unauthorized" => AgentAuthorizationState.AwaitingAuthorization,
            _ => AgentAuthorizationState.Enrolling
        };
        SetState(state, error);
    }

    private void ApplyIdentity(DeviceIdentity identity)
    {
        if (string.IsNullOrEmpty(_options.DeviceId) || _options.DeviceId != identity.DeviceId.ToString())
        {
            _options.DeviceId = identity.DeviceId.ToString();
        }

        if (!string.IsNullOrEmpty(identity.ApiKey))
        {
            _options.DeviceApiKey = identity.ApiKey;
        }
    }

    private void SetState(AgentAuthorizationState state, string? error)
    {
        if (_state != state)
        {
            _logger.LogInformation("Agent authorization state: {Previous} -> {Current}", _state, state);
        }
        _state = state;
        _lastError = error;
        WriteStatusFile();
    }

    /// <summary>
    /// Publishes the enrollment state for the installer and local operators.
    /// Contains no secret material.
    /// </summary>
    private void WriteStatusFile()
    {
        try
        {
            var payload = new
            {
                state = _state.ToString(),
                device_id = _identity?.DeviceId,
                install_id = _identity?.InstallId,
                organization_id = _identity?.OrganizationId,
                enrollment_status = _identity?.EnrollmentStatus,
                last_error = _lastError,
                updated_at = DateTimeOffset.UtcNow
            };

            File.WriteAllText(
                _statusFilePath,
                JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _logger.LogDebug("Could not write enrollment status file: {Message}", ex.Message);
        }
    }
}
