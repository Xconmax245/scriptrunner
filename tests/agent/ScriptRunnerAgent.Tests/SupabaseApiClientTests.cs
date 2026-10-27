using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;
using Xunit;

namespace ScriptRunnerAgent.Tests;

public class SupabaseApiClientTests
{
    private class MockHttpMessageHandler : HttpMessageHandler
    {
        public Func<HttpRequestMessage, HttpResponseMessage> Handler { get; set; } =
            _ => new HttpResponseMessage(HttpStatusCode.OK);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(Handler(request));
        }
    }

    private static AgentOptions CreateOptions() => new()
    {
        SupabaseUrl = "http://127.0.0.1:54321",
        SupabaseAnonKey = "anon_key_test",
        EnrollmentKey = "test-enrollment-key",
        DeviceId = Guid.NewGuid().ToString(),
        DeviceApiKey = new string('a', 64)
    };

    [Fact]
    public async Task AuthenticateAsync_ValidCredentials_CachesToken()
    {
        int authCalls = 0;
        var mockHandler = new MockHttpMessageHandler
        {
            Handler = req =>
            {
                if (req.RequestUri!.AbsolutePath.Contains("functions/v1/device-auth"))
                {
                    authCalls++;
                    var respJson = JsonSerializer.Serialize(new
                    {
                        access_token = "mock_jwt_token_12345",
                        token_type = "Bearer",
                        expires_in = 3600
                    });

                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(respJson, System.Text.Encoding.UTF8, "application/json")
                    };
                }
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }
        };

        var client = new SupabaseApiClient(
            new HttpClient(mockHandler), Options.Create(CreateOptions()),
            NullLogger<SupabaseApiClient>.Instance);

        var first = await client.AuthenticateAsync(CancellationToken.None);
        var second = await client.AuthenticateAsync(CancellationToken.None);

        Assert.True(first.Success);
        Assert.True(second.Success);
        Assert.Equal(1, authCalls); // cached token reused
    }

    [Fact]
    public async Task AuthenticateAsync_RevokedDevice_IsReportedAsRevoked()
    {
        var mockHandler = new MockHttpMessageHandler
        {
            Handler = _ => new HttpResponseMessage(HttpStatusCode.Forbidden)
            {
                Content = new StringContent("{\"error\":\"Device revoked\"}")
            }
        };

        var client = new SupabaseApiClient(
            new HttpClient(mockHandler), Options.Create(CreateOptions()),
            NullLogger<SupabaseApiClient>.Instance);

        var result = await client.AuthenticateAsync(CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.Revoked);
        Assert.True(result.NotAuthorized);
    }

    [Fact]
    public async Task SendHeartbeatAsync_UsesGatewayAndReturnsPendingCount()
    {
        string? capturedBody = null;
        var mockHandler = new MockHttpMessageHandler
        {
            Handler = req =>
            {
                if (req.RequestUri!.AbsolutePath.Contains("device-auth"))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("{\"access_token\":\"tok\",\"expires_in\":3600}")
                    };
                }
                if (req.RequestUri!.AbsolutePath.Contains("agent-gateway"))
                {
                    capturedBody = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"enrollment_status\":\"enrolled\",\"pending_jobs_count\":2}")
                    };
                }
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }
        };

        var client = new SupabaseApiClient(
            new HttpClient(mockHandler), Options.Create(CreateOptions()),
            NullLogger<SupabaseApiClient>.Instance);

        var result = await client.SendHeartbeatAsync(
            new AgentTelemetry
            {
                Hostname = "FIN-PC-04",
                OperatingSystem = "Windows 11 Pro",
                ServiceStatus = "running",
                IsElevated = false,
                ExecutionAccount = @"NT AUTHORITY\NETWORK SERVICE"
            },
            CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(2, result.PendingJobsCount);
        Assert.NotNull(capturedBody);
        Assert.Contains("\"action\":\"heartbeat\"", capturedBody);
        Assert.Contains("FIN-PC-04", capturedBody);
    }

    [Fact]
    public async Task SendHeartbeatAsync_SuspendedDeviceIsFlaggedNotAuthorized()
    {
        var mockHandler = new MockHttpMessageHandler
        {
            Handler = req =>
            {
                if (req.RequestUri!.AbsolutePath.Contains("device-auth"))
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("{\"access_token\":\"tok\",\"expires_in\":3600}")
                    };
                }
                return new HttpResponseMessage(HttpStatusCode.Forbidden)
                {
                    Content = new StringContent(
                        "{\"code\":\"device_not_authorized\",\"enrollment_status\":\"suspended\"}")
                };
            }
        };

        var client = new SupabaseApiClient(
            new HttpClient(mockHandler), Options.Create(CreateOptions()),
            NullLogger<SupabaseApiClient>.Instance);

        var result = await client.SendHeartbeatAsync(new AgentTelemetry(), CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.NotAuthorized);
        Assert.Equal("suspended", result.EnrollmentStatus);
    }

    [Fact]
    public async Task EnrollAsync_ReturnsDeviceCredential()
    {
        var mockHandler = new MockHttpMessageHandler
        {
            Handler = req =>
            {
                Assert.Contains("functions/v1/enroll-device", req.RequestUri!.AbsolutePath);
                var body = JsonSerializer.Serialize(new
                {
                    device_id = Guid.NewGuid(),
                    organization_id = Guid.NewGuid(),
                    enrollment_status = "unauthorized",
                    api_key = new string('b', 64)
                });
                return new HttpResponseMessage(HttpStatusCode.Created)
                {
                    Content = new StringContent(body)
                };
            }
        };

        var client = new SupabaseApiClient(
            new HttpClient(mockHandler), Options.Create(CreateOptions()),
            NullLogger<SupabaseApiClient>.Instance);

        var result = await client.EnrollAsync(
            new DeviceIdentity { DeviceId = Guid.NewGuid(), InstallId = Guid.NewGuid() },
            CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(64, result.ApiKey!.Length);
        Assert.Equal("unauthorized", result.EnrollmentStatus);
    }
}

public class EnrollmentServiceTests
{
    private sealed class FakeIdentityStore : IDeviceIdentityStore
    {
        public FakeIdentityStore(DeviceIdentity identity) => Identity = identity;
        public DeviceIdentity Identity { get; private set; }
        public string IdentityFilePath => "memory";
        public DeviceIdentity LoadOrCreate() => Identity;
        public Task SaveAsync(DeviceIdentity identity, CancellationToken cancellationToken)
        {
            Identity = identity;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeApiClient : ISupabaseApiClient
    {
        public AuthResult AuthResult { get; set; } = new() { Success = true };
        public EnrollmentResponse EnrollmentResult { get; set; } =
            new() { Success = true, EnrollmentStatus = "enrolled", ApiKey = new string('c', 64) };

        public int EnrollCalls { get; private set; }
        public int AuthCalls { get; private set; }

        public Task<AuthResult> AuthenticateAsync(CancellationToken cancellationToken)
        {
            AuthCalls++;
            return Task.FromResult(AuthResult);
        }

        public Task<EnrollmentResponse> EnrollAsync(DeviceIdentity identity, CancellationToken cancellationToken)
        {
            EnrollCalls++;
            LastEnrollmentIdentity = identity;
            return Task.FromResult(EnrollmentResult);
        }

        public DeviceIdentity? LastEnrollmentIdentity { get; private set; }

        public Task<HeartbeatResult> SendHeartbeatAsync(AgentTelemetry telemetry, CancellationToken cancellationToken) =>
            Task.FromResult(new HeartbeatResult { Success = true });

        public Task<AgentRmmConfig?> GetAgentConfigAsync(CancellationToken cancellationToken) =>
            Task.FromResult<AgentRmmConfig?>(new AgentRmmConfig());

        public Task<bool> SendInventoryAsync(
            HardwareInventory hardware,
            OperatingSystemInventory os,
            NetworkInventory network,
            IReadOnlyList<string> dataQuality,
            DateTimeOffset collectedAt,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<bool> SendMetricsAsync(
            IReadOnlyList<MetricSample> samples,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<bool> SendSoftwareInventoryAsync(
            IReadOnlyList<SoftwareApplication> applications,
            DateTimeOffset collectedAt,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<bool> SendEventsAsync(
            IReadOnlyList<EventLogEntryDto> events,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<bool> ReportMonitorResultAsync(
            Guid monitorId,
            MonitorOutcome outcome,
            DateTimeOffset observedAt,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<DeploymentWorkItem?> ClaimDeploymentAsync(CancellationToken cancellationToken) =>
            Task.FromResult<DeploymentWorkItem?>(null);

        public Task<bool> UpdateDeploymentAsync(
            Guid jobId,
            string state,
            int? progress,
            int? exitCode,
            string? output,
            string? error,
            bool? rebootRequired,
            CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<List<PendingJobItem>> GetPendingJobsAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new List<PendingJobItem>());

        public Task<ClaimJobResponse> ClaimJobAsync(Guid jobId, CancellationToken cancellationToken) =>
            Task.FromResult(new ClaimJobResponse());

        public Task<bool> MarkJobRunningAsync(Guid jobId, int attemptNumber, string agentExecutionId, DateTimeOffset startedAt, CancellationToken cancellationToken) =>
            Task.FromResult(true);

        public Task<bool> ReportJobCompletionAsync(ReportCompletionRequest request, CancellationToken cancellationToken) =>
            Task.FromResult(true);

        public Task<List<LocalExecutionState>> GetAmbiguousJobsAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new List<LocalExecutionState>());

        public Task<TerminalClaimResult?> ClaimTerminalSessionAsync(string agentInstanceId, CancellationToken cancellationToken) =>
            Task.FromResult<TerminalClaimResult?>(null);

        public Task<TerminalPollResult> PollTerminalCommandsAsync(Guid sessionId, CancellationToken cancellationToken) =>
            Task.FromResult(new TerminalPollResult());

        public Task<TerminalOutputAck?> SendTerminalOutputAsync(Guid sessionId, IReadOnlyList<TerminalOutputChunk> chunks, CancellationToken cancellationToken) =>
            Task.FromResult<TerminalOutputAck?>(new TerminalOutputAck { Success = true });

        public Task<TerminalSessionState> GetTerminalSessionStateAsync(Guid sessionId, CancellationToken cancellationToken) =>
            Task.FromResult(new TerminalSessionState { Status = "active" });

        public Task<bool> ReportTerminalCommandResultAsync(Guid sessionId, long sequence, bool exitOk, string? error, CancellationToken cancellationToken) =>
            Task.FromResult(true);

        public Task<bool> EndTerminalSessionAsync(Guid sessionId, string reason, CancellationToken cancellationToken) =>
            Task.FromResult(true);
    }

    private static EnrollmentService CreateService(
        FakeApiClient api,
        FakeIdentityStore store,
        out AgentOptions options)
    {
        options = new AgentOptions
        {
            SupabaseUrl = "http://localhost",
            SupabaseAnonKey = "anon",
            EnrollmentKey = "fleet-key",
            LocalStateDirectory = Path.Combine(Path.GetTempPath(), "sr-enroll-tests-" + Guid.NewGuid().ToString("N"))
        };

        return new EnrollmentService(
            api, store, Options.Create(options), NullLogger<EnrollmentService>.Instance);
    }

    [Fact]
    public async Task EnsureAuthorizedAsync_AutoAuthorizedEnrollment_PersistsCredential()
    {
        var identity = new DeviceIdentity { DeviceId = Guid.NewGuid(), InstallId = Guid.NewGuid() };
        var store = new FakeIdentityStore(identity);
        var api = new FakeApiClient
        {
            EnrollmentResult = new EnrollmentResponse
            {
                Success = true,
                EnrollmentStatus = "enrolled",
                ApiKey = new string('d', 64),
                OrganizationId = Guid.NewGuid()
            }
        };

        var service = CreateService(api, store, out var options);
        var authorized = await service.EnsureAuthorizedAsync(CancellationToken.None);

        Assert.True(authorized);
        Assert.Equal(AgentAuthorizationState.Authorized, service.State);
        Assert.Equal(1, api.EnrollCalls);
        Assert.Equal(new string('d', 64), store.Identity.ApiKey);
        Assert.Equal(new string('d', 64), options.DeviceApiKey);
        Assert.Equal(identity.DeviceId.ToString(), options.DeviceId);
    }

    [Fact]
    public async Task EnsureAuthorizedAsync_UnauthorizedPolicy_DoesNotClaimAuthorization()
    {
        var store = new FakeIdentityStore(new DeviceIdentity
        {
            DeviceId = Guid.NewGuid(),
            InstallId = Guid.NewGuid()
        });
        var api = new FakeApiClient
        {
            EnrollmentResult = new EnrollmentResponse
            {
                Success = true,
                EnrollmentStatus = "unauthorized",
                ApiKey = new string('e', 64)
            }
        };

        var service = CreateService(api, store, out _);
        var authorized = await service.EnsureAuthorizedAsync(CancellationToken.None);

        Assert.False(authorized);
        Assert.Equal(AgentAuthorizationState.AwaitingAuthorization, service.State);
        Assert.Equal(new string('e', 64), store.Identity.ApiKey);
    }

    [Fact]
    public async Task EnsureAuthorizedAsync_TransientFailure_RetriesOnNextCall()
    {
        var identity = new DeviceIdentity
        {
            DeviceId = Guid.NewGuid(),
            InstallId = Guid.NewGuid()
        };
        var store = new FakeIdentityStore(identity);
        var api = new FakeApiClient
        {
            EnrollmentResult = new EnrollmentResponse
            {
                Success = false,
                Error = "network unavailable"
            }
        };

        var service = CreateService(api, store, out _);
        var first = await service.EnsureAuthorizedAsync(CancellationToken.None);

        Assert.False(first);
        Assert.Equal(AgentAuthorizationState.Enrolling, service.State);
        Assert.Equal(1, api.EnrollCalls);
        Assert.Null(store.Identity.ApiKey); // nothing persisted on failure

        api.EnrollmentResult = new EnrollmentResponse
        {
            Success = true,
            EnrollmentStatus = "enrolled",
            ApiKey = new string('f', 64)
        };

        // The retry interval delays the next attempt; emulate the worker's wait.
        var field = typeof(EnrollmentService).GetField("_lastAttemptAt",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        field!.SetValue(service, DateTimeOffset.UtcNow - TimeSpan.FromMinutes(1));

        var second = await service.EnsureAuthorizedAsync(CancellationToken.None);
        Assert.True(second);
        Assert.Equal(2, api.EnrollCalls);
    }

    [Fact]
    public async Task EnsureAuthorizedAsync_RevokedDevice_StopsWithoutReenrolling()
    {
        var store = new FakeIdentityStore(new DeviceIdentity
        {
            DeviceId = Guid.NewGuid(),
            InstallId = Guid.NewGuid(),
            ApiKey = new string('a', 64)
        });
        var api = new FakeApiClient
        {
            AuthResult = new AuthResult
            {
                Success = false,
                StatusCode = 403,
                Revoked = true,
                NotAuthorized = true,
                Error = "Device revoked"
            }
        };

        var service = CreateService(api, store, out _);
        var authorized = await service.EnsureAuthorizedAsync(CancellationToken.None);

        Assert.False(authorized);
        Assert.Equal(AgentAuthorizationState.Revoked, service.State);
        Assert.Equal(0, api.EnrollCalls);
    }

    [Fact]
    public async Task EnsureAuthorizedAsync_SuspendedDevice_DoesNotReenroll()
    {
        var store = new FakeIdentityStore(new DeviceIdentity
        {
            DeviceId = Guid.NewGuid(),
            InstallId = Guid.NewGuid(),
            ApiKey = new string('a', 64)
        });
        var api = new FakeApiClient
        {
            AuthResult = new AuthResult
            {
                Success = false,
                StatusCode = 403,
                NotAuthorized = true,
                Error = "Device not enrolled"
            }
        };

        var service = CreateService(api, store, out _);
        var authorized = await service.EnsureAuthorizedAsync(CancellationToken.None);

        Assert.False(authorized);
        Assert.Equal(AgentAuthorizationState.AwaitingAuthorization, service.State);
        Assert.Equal(0, api.EnrollCalls);
    }
}
