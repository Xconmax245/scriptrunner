using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading.Tasks;

namespace ScriptRunnerAgent.Installer;

public static class AgentInstaller
{
    private const string ServiceName = "ScriptRunnerAgent";

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
                await Task.Delay(1000);

                // Step 2: Create directories & deploy files
                reportProgress(35, "Deploying agent files to Program Files...");
                Directory.CreateDirectory(installDir);
                Directory.CreateDirectory(stateDir);
                Directory.CreateDirectory(workDir);

                string currentExePath = Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0];
                string targetExePath = Path.Combine(installDir, "ScriptRunnerAgent.exe");

                if (!string.Equals(currentExePath, targetExePath, StringComparison.OrdinalIgnoreCase))
                {
                    // Copy with retries in case file was briefly busy
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
                        // Fallback attempt
                        File.Copy(currentExePath, targetExePath, overwrite: true);
                    }
                }

                // Step 3: Write configuration
                reportProgress(55, "Configuring secure service settings...");
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

                reportProgress(100, "Installation complete.");
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

    private static string GetDefaultAppSettings()
    {
        return @"{
  ""ScriptRunner"": {
    ""SupabaseUrl"": ""https://your-project.supabase.co"",
    ""SupabaseAnonKey"": ""REPLACE_WITH_SUPABASE_ANON_KEY"",
    ""EnrollmentKey"": ""REPLACE_WITH_ORGANIZATION_ENROLLMENT_KEY"",
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
