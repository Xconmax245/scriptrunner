using System.Diagnostics.Eventing.Reader;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Monitoring;

/// <summary>
/// Incremental Windows event log collection.
///
/// Only configured logs are read. The Security log requires an explicit local
/// opt-in *and* an organisation policy flag, and is always filtered by an
/// event ID allowlist rather than collected indiscriminately. A per-log
/// bookmark makes collection restart-safe; the database enforces a unique
/// dedupe key so replays are harmless.
/// </summary>
public sealed class EventLogScanner
{
    private readonly AgentOptions _options;
    private readonly RmmStateStore _stateStore;
    private readonly ILogger<EventLogScanner> _logger;

    public EventLogScanner(
        IOptions<AgentOptions> options,
        RmmStateStore stateStore,
        ILogger<EventLogScanner> logger)
    {
        _options = options.Value;
        _stateStore = stateStore;
        _logger = logger;
    }

    public async Task<List<EventLogEntryDto>> ScanAsync(
        bool organizationAllowsSecurityLog,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        var state = await _stateStore.LoadAsync(cancellationToken);
        var collected = new List<EventLogEntryDto>();
        var totalBytes = 0;
        var changed = false;
        var maxEvents = Math.Clamp(_options.MaxEventsPerScan, 1, 1000);

        foreach (var logName in _options.EventLogs.Where(l => !string.IsNullOrWhiteSpace(l)).Distinct())
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (logName.Equals("Security", StringComparison.OrdinalIgnoreCase))
            {
                if (!_options.EnableSecurityEventLog || !organizationAllowsSecurityLog
                    || _options.SecurityEventIds.Length == 0)
                {
                    _logger.LogDebug(
                        "Security event log collection skipped (local opt-in: {Local}, policy: {Policy}, ids: {Ids}).",
                        _options.EnableSecurityEventLog, organizationAllowsSecurityLog,
                        _options.SecurityEventIds.Length);
                    continue;
                }
            }

            long bookmark = state.EventBookmarks.TryGetValue(logName, out var value) ? value : 0;

            try
            {
                var query = BuildQuery(logName, bookmark);
                var readerQuery = new EventLogQuery(logName, PathType.LogName, query)
                {
                    ReverseDirection = false,
                    TolerateQueryErrors = false
                };

                using var reader = new EventLogReader(readerQuery);
                long lastRecordId = bookmark;
                int read = 0;

                for (var record = reader.ReadEvent(); record is not null; record = reader.ReadEvent())
                {
                    using (record)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        read++;

                        // RecordId is the log record number (monotonic per log);
                        // Id is the provider event ID and is not unique.
                        var recordId = record.RecordId ?? 0;
                        var message = TryGetMessage(record);
                        var entry = new EventLogEntryDto
                        {
                            LogName = logName,
                            Provider = record.ProviderName,
                            EventId = record.Id,
                            Level = LevelName(record.Level),
                            RecordedAt = record.TimeCreated?.ToUniversalTime().ToString("o"),
                            Message = Truncate(message, 4000),
                            DedupeKey = $"{logName}|{recordId}",
                            Details = new Dictionary<string, object?>
                            {
                                ["record_id"] = recordId,
                                ["level_value"] = record.Level,
                                ["process_id"] = record.ProcessId,
                                ["thread_id"] = record.ThreadId,
                                ["machine_name"] = record.MachineName
                            }
                        };

                        collected.Add(entry);
                        totalBytes += Encoding.UTF8.GetByteCount(entry.Message ?? string.Empty);
                        if (recordId > lastRecordId) lastRecordId = recordId;

                        if (read >= maxEvents || totalBytes >= maxBytes)
                        {
                            break;
                        }
                    }
                }

                if (lastRecordId > bookmark)
                {
                    state.EventBookmarks[logName] = lastRecordId;
                    changed = true;
                }
            }
            catch (EventLogNotFoundException)
            {
                _logger.LogDebug("Event log {Log} does not exist on this host.", logName);
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogWarning("Access denied reading event log {Log}: {Message}", logName, ex.Message);
            }
            catch (EventLogException ex)
            {
                _logger.LogWarning("Event log {Log} query failed: {Message}", logName, ex.Message);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Event log {Log} scan failed: {Message}", logName, ex.Message);
            }

            if (totalBytes >= maxBytes) break;
        }

        if (changed)
        {
            state.LastEventScanAt = DateTimeOffset.UtcNow;
            await _stateStore.SaveAsync(state, cancellationToken);
        }

        return collected;
    }

    private string BuildQuery(string logName, long bookmark)
    {
        var parts = new List<string>();

        // Record IDs are numeric and come from our own file, but reject anything
        // negative to keep the XPath well formed.
        if (bookmark > 0) parts.Add($"EventRecordID > {bookmark}");

        if (logName.Equals("Security", StringComparison.OrdinalIgnoreCase))
        {
            var ids = _options.SecurityEventIds.Where(id => id > 0).Distinct().Take(50).ToList();
            parts.Add("(" + string.Join(" or ", ids.Select(id => $"EventID={id}")) + ")");
        }
        else
        {
            var maxLevel = Math.Clamp(_options.MinimumEventLevel, 1, 5);
            parts.Add($"Level <= {maxLevel}");

            if (_options.IncludeEventIds.Length > 0)
            {
                var ids = _options.IncludeEventIds.Where(id => id > 0).Distinct().Take(50);
                parts.Add("(" + string.Join(" or ", ids.Select(id => $"EventID={id}")) + ")");
            }
        }

        var excluded = _options.ExcludeEventIds.Where(id => id > 0).Distinct().Take(50).ToList();
        if (excluded.Count > 0)
        {
            parts.Add("not (" + string.Join(" or ", excluded.Select(id => $"EventID={id}")) + ")");
        }

        if (parts.Count == 0) return "*";
        return "*[System[" + string.Join(" and ", parts) + "]]";
    }

    private static string? TryGetMessage(EventRecord record)
    {
        try
        {
            return record.FormatDescription();
        }
        catch
        {
            return null;
        }
    }

    private static string? LevelName(byte? level) => level switch
    {
        1 => "Critical",
        2 => "Error",
        3 => "Warning",
        4 => "Information",
        5 => "Verbose",
        _ => level is null ? null : "LogAlways"
    };

    private static string? Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return value.Length <= max ? value : value[..max];
    }
}
