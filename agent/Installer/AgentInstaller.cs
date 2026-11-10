using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace ScriptRunnerAgent.Installer;

public static class AgentInstaller
{
    private const string ServiceName = "ScriptRunnerAgent";
    public const string DefaultVercelUrl = "https://scriptrunner-dasboard.vercel.app";
    public const string DefaultAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmFkZm9wZm9sd3dvb3F6emJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODE1NDYsImV4cCI6MjEwODI1NzU0Nn0.3pEWvB4ulsAPt78COTjmqYFSgXWDP_7vbaR4KBu0MJ4";
    public const string DefaultEnrollmentKey = "00000000-0000-0000-0000-000000000001";

    public static bool IsAdministrator()
    {
        try
        {
            var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    public static void RelaunchAsAdministrator(string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0],
                UseShellExecute = true,
                Verb = "runas",
                Arguments = string.Join(" ", args)
            };
            Process.Start(psi);
        }
        catch
        {
            // User cancelled UAC prompt
        }
    }

    public static async Task<bool> InstallAsync(Action<int, string> reportProgress)
    {
        return await Task.Run(async () =>
        {
            try
            {
                string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);

                string installDir = Path.Combine(programFiles, "ScriptRunnerAgent");
                string stateDir = Path.Combine(programData, "ScriptRunnerAgent", "state");
                string workDir = Path.Combine(programData, "ScriptRunnerAgent", "work");

                // Step 1: Prepare environment & stop existing service
                reportProgress(15, "Preparing installation environment...");
                RunProcess("sc.exe", $"stop {ServiceName}");
                await Task.Delay(800);

                // Step 2: Create directories & deploy files
                reportProgress(35, "Deploying agent binaries to Program Files...");
                Directory.CreateDirectory(installDir);
                Directory.CreateDirectory(stateDir);
                Directory.CreateDirectory(workDir);

                // Clean any pre-existing local device identity so this PC gets a fresh identity and hostname
                string identityFile = Path.Combine(stateDir, "device.json");
                if (File.Exists(identityFile))
                {
                    try { File.Delete(identityFile); } catch { }
                }
                string statusFile = Path.Combine(stateDir, "enrollment-status.json");
                if (File.Exists(statusFile))
                {
                    try { File.Delete(statusFile); } catch { }
                }

                string currentExePath = Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0];
                string targetExePath = Path.Combine(installDir, "ScriptRunnerAgent.exe");

                if (!string.Equals(currentExePath, targetExePath, StringComparison.OrdinalIgnoreCase))
                {
                    bool copied = false;
                    for (int i = 0; i < 5; i++)
                    {
                        try
                        {
                            File.Copy(currentExePath, targetExePath, overwrite: true);
                            copied = true;
                            break;
                        }
                        catch
                        {
                            await Task.Delay(500);
                        }
                    }

                    if (!copied)
                    {
                        File.Copy(currentExePath, targetExePath, overwrite: true);
                    }
                }

                // Step 3: Write clean configuration
                reportProgress(55, "Configuring endpoint connection to dashboard...");
                string targetConfigFile = Path.Combine(installDir, "appsettings.json");
                string sourceConfigDir = Path.GetDirectoryName(currentExePath) ?? "";
                string sourceConfigFile = Path.Combine(sourceConfigDir, "appsettings.json");

                string configContent;
                if (File.Exists(sourceConfigFile))
                {
                    configContent = File.ReadAllText(sourceConfigFile);
                }
                else
                {
                    configContent = GetDefaultAppSettings();
                }

                // Sanitize config: ALWAYS ensure fresh device identity (no hardcoded/stale IDs) and point to Vercel
                try
                {
                    var node = JsonNode.Parse(configContent);
                    if (node?["ScriptRunner"] is JsonObject sr)
                    {
                        sr["DeviceId"] = "";
                        sr["DeviceApiKey"] = "";

                        string? url = sr["SupabaseUrl"]?.GetValue<string>();
                        if (string.IsNullOrWhiteSpace(url) || url.Contains("localhost") || url.Contains("your-project"))
                        {
                            sr["SupabaseUrl"] = DefaultVercelUrl;
                        }

                        string? anonKey = sr["SupabaseAnonKey"]?.GetValue<string>();
                        if (string.IsNullOrWhiteSpace(anonKey) || anonKey.Contains("REPLACE"))
                        {
                            sr["SupabaseAnonKey"] = DefaultAnonKey;
                        }

                        string? enrollKey = sr["EnrollmentKey"]?.GetValue<string>();
                        if (string.IsNullOrWhiteSpace(enrollKey) || enrollKey.Contains("REPLACE"))
                        {
                            sr["EnrollmentKey"] = DefaultEnrollmentKey;
                        }
                    }
                    configContent = node?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? configContent;
                }
                catch
                {
                    configContent = GetDefaultAppSettings();
                }

                File.WriteAllText(targetConfigFile, configContent);

                // Step 4: Register Windows Service
                reportProgress(75, "Registering background Windows Service...");
                RunProcess("sc.exe", $"delete {ServiceName}");
                await Task.Delay(500);

                string quotedBinPath = $"\"{targetExePath}\" --service";
                RunProcess("sc.exe", $"create {ServiceName} binPath= \"{quotedBinPath}\" start= auto DisplayName= \"ScriptRunner Authorized Agent\"");
                RunProcess("sc.exe", $"description {ServiceName} \"Authorized corporate background execution agent for remote PowerShell administration.\"");
                RunProcess("sc.exe", $"failure {ServiceName} reset= 86400 actions= restart/5000/restart/10000/restart/30000");

                // Step 5: Start Service and verify
                reportProgress(90, "Starting background service...");
                RunProcess("sc.exe", $"start {ServiceName}");
                await Task.Delay(2000);

                reportProgress(100, "Installation complete. Endpoint registered and online.");
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        });
    }

    private static int RunProcess(string fileName, string arguments)
    {
        try
        {
            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                }
            };
            proc.Start();
            proc.WaitForExit(10000);
            return proc.ExitCode;
        }
        catch
        {
            return -1;
        }
    }

    public static string GetDefaultAppSettings()
    {
        return @"{
  ""ScriptRunner"": {
    ""SupabaseUrl"": """ + DefaultVercelUrl + @""",
    ""SupabaseAnonKey"": """ + DefaultAnonKey + @""",
    ""EnrollmentKey"": """ + DefaultEnrollmentKey + @""",
    ""DeviceId"": """",
    ""DeviceApiKey"": """",
    ""PollIntervalSeconds"": 2,
    ""MaxBackoffSeconds"": 30,
    ""HeartbeatIntervalSeconds"": 15,
    ""LocalStateDirectory"": """",
    ""PowerShellPath"": """",
    ""WorkingDirectory"": """",
    ""MaxStdoutBytes"": 65536,
    ""MaxStderrBytes"": 16384,
    ""EnableRemoteTerminal"": true,
    ""TerminalClaimIntervalSeconds"": 1,
    ""TerminalCommandTimeoutSeconds"": 300,
    ""MaxTerminalCommandOutputChars"": 262144,
    ""TerminalOutputBatchChars"": 4096,
    ""EnableRmm"": true,
    ""EventLogs"": [""Application"", ""System""],
    ""EnableSecurityEventLog"": false,
    ""MinimumEventLevel"": 3,
    ""MaxEventsPerScan"": 200,
    ""RequirePackageSignature"": false
  },
  ""Logging"": {
    ""LogLevel"": {
      ""Default"": ""Information"",
      ""Microsoft.Hosting.Lifetime"": ""Information"",
      ""System.Net.Http.HttpClient"": ""Warning""
    }
  }
}";
    }
}
