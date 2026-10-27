using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;

namespace ScriptRunnerAgent.Services;

/// <summary>
/// Identity generated locally by the installation. The device ID is never typed
/// by an administrator; the install ID makes enrollment retries idempotent.
/// </summary>
public sealed class DeviceIdentity
{
    [JsonPropertyName("device_id")]
    public Guid DeviceId { get; set; }

    [JsonPropertyName("install_id")]
    public Guid InstallId { get; set; }

    [JsonPropertyName("device_api_key")]
    public string? ApiKey { get; set; }

    [JsonPropertyName("organization_id")]
    public Guid? OrganizationId { get; set; }

    [JsonPropertyName("enrollment_status")]
    public string? EnrollmentStatus { get; set; }

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("enrolled_at")]
    public DateTimeOffset? EnrolledAt { get; set; }
}

public interface IDeviceIdentityStore
{
    DeviceIdentity LoadOrCreate();
    Task SaveAsync(DeviceIdentity identity, CancellationToken cancellationToken);
    string IdentityFilePath { get; }
}

public sealed class DeviceIdentityStore : IDeviceIdentityStore
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true
    };

    private readonly AgentOptions _options;
    private readonly ILogger<DeviceIdentityStore> _logger;
    private readonly object _lock = new();

    public DeviceIdentityStore(IOptions<AgentOptions> options, ILogger<DeviceIdentityStore> logger)
    {
        _options = options.Value;
        _logger = logger;

        string stateDir;
        if (!string.IsNullOrWhiteSpace(_options.LocalStateDirectory))
        {
            stateDir = _options.LocalStateDirectory;
        }
        else
        {
            try
            {
                var common = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "ScriptRunnerAgent",
                    "state");
                Directory.CreateDirectory(common);
                stateDir = common;
            }
            catch
            {
                var local = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ScriptRunnerAgent",
                    "state");
                Directory.CreateDirectory(local);
                stateDir = local;
            }
        }

        Directory.CreateDirectory(stateDir);
        IdentityFilePath = Path.Combine(stateDir, "device.json");
    }

    public string IdentityFilePath { get; }

    public DeviceIdentity LoadOrCreate()
    {
        lock (_lock)
        {
            DeviceIdentity? identity = null;

            try
            {
                if (File.Exists(IdentityFilePath))
                {
                    identity = JsonSerializer.Deserialize<DeviceIdentity>(
                        File.ReadAllText(IdentityFilePath), JsonOpts);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Local device identity file is unreadable; generating a new identity.");
            }

            if (identity is not null && identity.DeviceId != Guid.Empty && identity.InstallId != Guid.Empty)
            {
                // If an authoritative DeviceId is configured in appsettings.json, use it!
                if (Guid.TryParse(_options.DeviceId, out var confId) && confId != Guid.Empty && identity.DeviceId != confId)
                {
                    identity.DeviceId = confId;
                    SaveSync(identity);
                }

                // Configuration values (legacy manual installs) win if they were
                // explicitly provided and the identity file has no credential.
                if (!string.IsNullOrWhiteSpace(_options.DeviceApiKey) &&
                    !_options.DeviceApiKey.StartsWith("REPLACE", StringComparison.OrdinalIgnoreCase) &&
                    string.IsNullOrEmpty(identity.ApiKey))
                {
                    identity.ApiKey = _options.DeviceApiKey;
                }

                return identity;
            }

            identity = new DeviceIdentity
            {
                DeviceId = Guid.NewGuid(),
                InstallId = Guid.NewGuid(),
                CreatedAt = DateTimeOffset.UtcNow
            };

            if (Guid.TryParse(_options.DeviceId, out var configuredId) && configuredId != Guid.Empty)
            {
                identity.DeviceId = configuredId;
            }

            if (!string.IsNullOrWhiteSpace(_options.DeviceApiKey) &&
                !_options.DeviceApiKey.StartsWith("REPLACE", StringComparison.OrdinalIgnoreCase))
            {
                identity.ApiKey = _options.DeviceApiKey;
            }

            SaveSync(identity);
            _logger.LogInformation(
                "Generated local device identity {DeviceId} (install {InstallId}).",
                identity.DeviceId, identity.InstallId);

            return identity;
        }
    }

    public Task SaveAsync(DeviceIdentity identity, CancellationToken cancellationToken)
    {
        lock (_lock)
        {
            SaveSync(identity);
        }
        return Task.CompletedTask;
    }

    private void SaveSync(DeviceIdentity identity)
    {
        string tempPath = IdentityFilePath + ".tmp";

        // Restrict the credential file to the service account, SYSTEM and
        // Administrators. The installer also locks down the containing folder.
        var streamOptions = new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.WriteThrough
        };

        using (var stream = new FileStream(tempPath, streamOptions))
        using (var writer = new StreamWriter(stream))
        {
            writer.Write(JsonSerializer.Serialize(identity, JsonOpts));
        }

        try
        {
            File.Move(tempPath, IdentityFilePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                try { File.Delete(tempPath); } catch { /* best effort */ }
            }
        }
    }
}
