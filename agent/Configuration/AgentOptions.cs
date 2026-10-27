namespace ScriptRunnerAgent.Configuration;

public class AgentOptions
{
    public const string SectionName = "ScriptRunner";

    /// <summary>
    /// Base URL of the Supabase project (e.g. https://xyzcompany.supabase.co or http://127.0.0.1:54321)
    /// </summary>
    public string SupabaseUrl { get; set; } = string.Empty;

    /// <summary>
    /// Public Anon Key used as the `apikey` header for the Supabase Edge Functions.
    /// </summary>
    public string SupabaseAnonKey { get; set; } = string.Empty;

    /// <summary>
    /// Organization-level enrollment key delivered to the installer. Only used
    /// until the device has received its own device credential. Never logged.
    /// </summary>
    public string EnrollmentKey { get; set; } = string.Empty;

    /// <summary>
    /// Unique enrolled device UUID. Populated automatically from the local
    /// identity file; the installer never requires the operator to type it.
    /// </summary>
    public string DeviceId { get; set; } = string.Empty;

    /// <summary>
    /// Secret device API key generated during enrollment (never shared, never logged).
    /// </summary>
    public string DeviceApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Base polling interval when idle (seconds)
    /// </summary>
    public int PollIntervalSeconds { get; set; } = 5;

    /// <summary>
    /// Maximum backoff delay on transient errors (seconds)
    /// </summary>
    public int MaxBackoffSeconds { get; set; } = 60;

    /// <summary>
    /// Interval between heartbeat reports to Supabase (seconds)
    /// </summary>
    public int HeartbeatIntervalSeconds { get; set; } = 30;

    /// <summary>
    /// Directory to store in-flight execution state for restart recovery
    /// Defaults to %ProgramData%\ScriptRunnerAgent\state
    /// </summary>
    public string LocalStateDirectory { get; set; } = string.Empty;

    /// <summary>
    /// Preferred PowerShell executable path. If empty, auto-detects PowerShell 7 then Windows PowerShell.
    /// </summary>
    public string PowerShellPath { get; set; } = string.Empty;

    /// <summary>
    /// Working directory for script execution. Defaults to the agent directory or system temp with restrictive ACL.
    /// </summary>
    public string WorkingDirectory { get; set; } = string.Empty;

    /// <summary>
    /// Max stdout bytes to capture before truncation (default: 65536)
    /// </summary>
    public int MaxStdoutBytes { get; set; } = 65536;

    /// <summary>
    /// Max stderr bytes to capture before truncation (default: 16384)
    /// </summary>
    public int MaxStderrBytes { get; set; } = 16384;

    // ------------------------------------------------------------------
    // Interactive remote terminal (persistent PowerShell session)
    // ------------------------------------------------------------------

    /// <summary>
    /// Allow authenticated administrators to open an interactive remote
    /// PowerShell session on this device.
    /// </summary>
    public bool EnableRemoteTerminal { get; set; } = true;

    /// <summary>
    /// Seconds between attempts to pick up a newly opened terminal session.
    /// </summary>
    public int TerminalClaimIntervalSeconds { get; set; } = 2;

    /// <summary>
    /// Hard limit for a single command, after which the PowerShell session is
    /// considered wedged and is recycled (state is reported as lost).
    /// </summary>
    public int TerminalCommandTimeoutSeconds { get; set; } = 300;

    /// <summary>
    /// Maximum characters of output forwarded per terminal command. Further output
    /// is discarded while the command drains (the session stays responsive).
    /// </summary>
    public int MaxTerminalCommandOutputChars { get; set; } = 262144;

    /// <summary>
    /// Number of characters of previously forwarded output to keep for the
    /// completion heuristic / diagnostics.
    /// </summary>
    public int TerminalOutputBatchChars { get; set; } = 4096;

    // ------------------------------------------------------------------
    // RMM monitoring / inventory / software deployment
    // ------------------------------------------------------------------

    /// <summary>Enable inventory, telemetry, monitoring and deployment work.</summary>
    public bool EnableRmm { get; set; } = true;

    /// <summary>Windows event logs scanned for monitoring events.</summary>
    public string[] EventLogs { get; set; } = { "Application", "System" };

    /// <summary>
    /// Local opt-in for the Security log. The organisation policy must also
    /// allow it before any Security event is read.
    /// </summary>
    public bool EnableSecurityEventLog { get; set; }

    /// <summary>Event IDs to collect from the Security log when enabled.</summary>
    public int[] SecurityEventIds { get; set; } = Array.Empty<int>();

    /// <summary>Maximum Windows event level to collect (1=Critical .. 5=Verbose).</summary>
    public int MinimumEventLevel { get; set; } = 3;

    /// <summary>Optional event ID allowlist. Empty means all qualifying events.</summary>
    public int[] IncludeEventIds { get; set; } = Array.Empty<int>();

    /// <summary>Event IDs never collected.</summary>
    public int[] ExcludeEventIds { get; set; } = Array.Empty<int>();

    /// <summary>Maximum events read per log per scan (bounded ingestion).</summary>
    public int MaxEventsPerScan { get; set; } = 200;

    /// <summary>Upper size bound for a downloaded package.</summary>
    public long MaxPackageDownloadBytes { get; set; } = 4L * 1024 * 1024 * 1024;

    /// <summary>
    /// Require a valid Authenticode signature whose subject matches the package
    /// metadata before executing an installer.
    /// </summary>
    public bool RequirePackageSignature { get; set; }

    /// <summary>Directory used for downloaded packages (defaults to ProgramData).</summary>
    public string DeploymentWorkingDirectory { get; set; } = string.Empty;

    /// <summary>Directory for RMM local state (event bookmarks, recovery cooldowns).</summary>
    public string RmmStateDirectory { get; set; } = string.Empty;
}
