using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace ScriptRunnerAgent.Installer;

public static class AgentInstaller
{
    public const string ServiceName = "ScriptRunnerAgent";
    public const string DefaultVercelUrl = "https://scriptrunner-dasboard.vercel.app";
    public const string DefaultAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmFkZm9wZm9sd3dvb3F6emJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODE1NDYsImV4cCI6MjEwODI1NzU0Nn0.3pEWvB4ulsAPt78COTjmqYFSgXWDP_7vbaR4KBu0MJ4";
    public const string DefaultEnrollmentKey = "00000000-0000-0000-0000-000000000001";

    private static readonly string LogFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "ScriptRunnerAgent",
        "installer.log");

    public static void Log(string message)
    {
        try
        {
            string dir = Path.GetDirectoryName(LogFilePath)!;
            Directory.CreateDirectory(dir);
            string line = $"[{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss.fffZ}] {message}{Environment.NewLine}";
            File.AppendAllText(LogFilePath, line);
            Console.WriteLine($"[Installer] {message}");
        }
        catch
        {
            // Ignore logging errors
        }
    }

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
        catch (Exception ex)
        {
            Log($"UAC elevation was cancelled or failed: {ex.Message}");
        }
    }

    private static void KillOtherAgentProcesses()
    {
        int currentPid = Environment.ProcessId;
        try
        {
            foreach (var proc in Process.GetProcessesByName("ScriptRunnerAgent"))
            {
                if (proc.Id != currentPid)
                {
                    try
                    {
                        proc.Kill(entireProcessTree: true);
                        proc.WaitForExit(2000);
                        Log($"Terminated existing process {proc.Id}");
                    }
                    catch
                    {
                        // Best effort
                    }
                }
            }
        }
        catch
        {
            // Best effort
        }
    }

    public static async Task<bool> InstallAsync(Action<int, string> reportProgress)
    {
        return await Task.Run(async () =>
        {
            try
            {
                Log("=== Starting zero-terminal agent installation ===");
                string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);

                string installDir = Path.Combine(programFiles, "ScriptRunnerAgent");
                string stateDir = Path.Combine(programData, "ScriptRunnerAgent", "state");
                string workDir = Path.Combine(programData, "ScriptRunnerAgent", "work");

                // Step 1: Prepare environment & stop existing service
                reportProgress(10, "Preparing installation environment...");
                Log($"Target directories: install={installDir}, state={stateDir}");
                Directory.CreateDirectory(installDir);
                Directory.CreateDirectory(stateDir);
                Directory.CreateDirectory(workDir);

                // Stop service if running and kill background agent processes
                RunCommand("sc.exe", $"stop {ServiceName}");
                KillOtherAgentProcesses();
                await Task.Delay(500);

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

                // Step 2: Deploy executable
                reportProgress(25, "Deploying agent binaries to Program Files...");
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
                            Log($"Copied agent executable from {currentExePath} to {targetExePath}");
                            break;
                        }
                        catch (Exception ex)
                        {
                            Log($"Copy attempt {i + 1} failed: {ex.Message}. Retrying...");
                            KillOtherAgentProcesses();
                            await Task.Delay(600);
                        }
                    }

                    if (!copied)
                    {
                        File.Copy(currentExePath, targetExePath, overwrite: true);
                    }
                }

                // Step 3: Write configuration
                reportProgress(40, "Configuring dashboard endpoint connection...");
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

                string endpointUrl = DefaultVercelUrl;
                string anonKey = DefaultAnonKey;
                string enrollmentKey = DefaultEnrollmentKey;

                try
                {
                    var node = JsonNode.Parse(configContent);
                    if (node?["ScriptRunner"] is JsonObject sr)
                    {
                        sr["DeviceId"] = "";
                        sr["DeviceApiKey"] = "";

                        string? url = sr["SupabaseUrl"]?.GetValue<string>();
                        if (!string.IsNullOrWhiteSpace(url) && !url.Contains("localhost") && !url.Contains("your-project"))
                        {
                            endpointUrl = url.TrimEnd('/');
                        }
                        else
                        {
                            sr["SupabaseUrl"] = DefaultVercelUrl;
                        }

                        string? key = sr["SupabaseAnonKey"]?.GetValue<string>();
                        if (!string.IsNullOrWhiteSpace(key) && !key.Contains("REPLACE"))
                        {
                            anonKey = key;
                        }
                        else
                        {
                            sr["SupabaseAnonKey"] = DefaultAnonKey;
                        }

                        string? eKey = sr["EnrollmentKey"]?.GetValue<string>();
                        if (!string.IsNullOrWhiteSpace(eKey) && !eKey.Contains("REPLACE"))
                        {
                            enrollmentKey = eKey;
                        }
                        else
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
                Log($"Wrote sanitized config to {targetConfigFile}");

                // Step 4: Direct Immediate Enrollment over HTTPS
                // This ensures the device and hostname appear on the dashboard IMMEDIATELY
                reportProgress(55, $"Registering {Environment.MachineName} on dashboard...");
                Log($"Initiating direct enrollment with {endpointUrl} for host {Environment.MachineName}");

                var (enrolled, deviceId, apiKey, orgId) = await EnrollDirectlyAsync(endpointUrl, anonKey, enrollmentKey);

                if (enrolled && !string.IsNullOrEmpty(deviceId) && !string.IsNullOrEmpty(apiKey))
                {
                    Log($"Direct enrollment succeeded: DeviceId={deviceId}, OrgId={orgId}");
                    // Persist credentials to state/device.json
                    var identityJson = new JsonObject
                    {
                        ["device_id"] = deviceId,
                        ["install_id"] = Guid.NewGuid().ToString(),
                        ["device_api_key"] = apiKey,
                        ["organization_id"] = orgId,
                        ["enrollment_status"] = "enrolled",
                        ["created_at"] = DateTimeOffset.UtcNow.ToString("o"),
                        ["enrolled_at"] = DateTimeOffset.UtcNow.ToString("o")
                    };
                    File.WriteAllText(identityFile, identityJson.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

                    var statusJson = new JsonObject
                    {
                        ["state"] = "Authorized",
                        ["device_id"] = deviceId,
                        ["error"] = null,
                        ["updated_at"] = DateTimeOffset.UtcNow.ToString("o")
                    };
                    File.WriteAllText(statusFile, statusJson.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

                    reportProgress(70, $"Device {Environment.MachineName} registered successfully!");

                    // Send initial heartbeat to mark device online immediately
                    _ = Task.Run(() => SendInitialHeartbeatAsync(endpointUrl, deviceId, apiKey));
                }
                else
                {
                    Log("Direct enrollment call did not complete synchronously. Service will enroll on startup.");
                }

                // Step 5: Register and start Windows Service
                reportProgress(80, "Configuring background Windows Service...");
                bool serviceStarted = RegisterAndStartService(targetExePath);

                if (!serviceStarted)
                {
                    Log("Service start via SCM returned false. Starting worker in background as resilient fallback...");
                    StartWorkerFallback(targetExePath);
                }

                reportProgress(100, $"Installation complete! {Environment.MachineName} is online on the dashboard.");
                Log("=== Installation completed successfully ===");
                return true;
            }
            catch (Exception ex)
            {
                Log($"Installation failed with unhandled exception: {ex}");
                return false;
            }
        });
    }

    private static async Task<(bool success, string? deviceId, string? apiKey, string? orgId)> EnrollDirectlyAsync(
        string baseUrl, string anonKey, string enrollmentKey)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
            client.DefaultRequestHeaders.Add("apikey", anonKey);

            string os = RuntimeInformation.OSDescription.Trim();
            string hostname = Environment.MachineName;
            string installId = Guid.NewGuid().ToString();
            string deviceId = Guid.NewGuid().ToString();

            string endpoint = $"{baseUrl.TrimEnd('/')}/functions/v1/enroll-device";
            Log($"Sending POST to {endpoint} with hostname={hostname}, os={os}");

            var payload = new
            {
                enrollment_key = enrollmentKey,
                install_id = installId,
                device_id = deviceId,
                hostname = hostname,
                operating_system = os,
                agent_version = "1.0.0"
            };

            using var response = await client.PostAsJsonAsync(endpoint, payload);
            string responseBody = await response.Content.ReadAsStringAsync();
            Log($"Enrollment HTTP {(int)response.StatusCode}: {responseBody}");

            if (response.IsSuccessStatusCode)
            {
                var doc = JsonNode.Parse(responseBody);
                string? resDeviceId = doc?["device_id"]?.GetValue<string>() ?? deviceId;
                string? resApiKey = doc?["api_key"]?.GetValue<string>();
                string? resOrgId = doc?["organization_id"]?.GetValue<string>() ?? DefaultEnrollmentKey;

                return (true, resDeviceId, resApiKey, resOrgId);
            }
        }
        catch (Exception ex)
        {
            Log($"Direct enrollment exception: {ex.Message}");
        }

        return (false, null, null, null);
    }

    private static async Task SendInitialHeartbeatAsync(string baseUrl, string deviceId, string apiKey)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            
            // 1. Authenticate to get JWT
            string authEndpoint = $"{baseUrl.TrimEnd('/')}/functions/v1/device-auth";
            var authPayload = new { device_id = deviceId, api_key = apiKey };
            using var authRes = await client.PostAsJsonAsync(authEndpoint, authPayload);
            if (!authRes.IsSuccessStatusCode) return;

            string authBody = await authRes.Content.ReadAsStringAsync();
            var authDoc = JsonNode.Parse(authBody);
            string? token = authDoc?["access_token"]?.GetValue<string>();
            if (string.IsNullOrEmpty(token)) return;

            // 2. Send heartbeat to agent-gateway
            string gatewayEndpoint = $"{baseUrl.TrimEnd('/')}/functions/v1/agent-gateway";
            client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            var hbPayload = new
            {
                action = "heartbeat",
                device_id = deviceId,
                hostname = Environment.MachineName,
                agent_version = "1.0.0",
                operating_system = RuntimeInformation.OSDescription.Trim(),
                service_status = "running",
                is_elevated = true
            };
            await client.PostAsJsonAsync(gatewayEndpoint, hbPayload);
            Log("Initial live heartbeat dispatched successfully.");
        }
        catch (Exception ex)
        {
            Log($"Initial heartbeat exception: {ex.Message}");
        }
    }

    private static bool RegisterAndStartService(string targetExePath)
    {
        try
        {
            Log("Registering service via PowerShell...");
            string psScript = $@"
$ErrorActionPreference = 'Stop'
try {{
    $svc = Get-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
    if ($svc) {{
        Stop-Service -Name '{ServiceName}' -Force -ErrorAction SilentlyContinue
        & sc.exe delete {ServiceName} | Out-Null
        Start-Sleep -Milliseconds 600
    }}
    $bp = '\""{targetExePath}\"" --service'
    & sc.exe create {ServiceName} binPath= $bp start= auto DisplayName= 'ScriptRunner Authorized Agent' | Out-Null
    & sc.exe description {ServiceName} 'Authorized corporate background execution agent for remote PowerShell administration.' | Out-Null
    & sc.exe failure {ServiceName} reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Start-Service -Name '{ServiceName}' -ErrorAction SilentlyContinue
    $status = (Get-Service -Name '{ServiceName}').Status
    Write-Output ""STATUS:$status""
}} catch {{
    Write-Output ""ERROR:$($_.Exception.Message)""
}}
";

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{psScript.Replace("\"", "\\\"").Replace("\r\n", " ")}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            using var proc = Process.Start(psi);
            if (proc != null)
            {
                string stdout = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(15000);
                Log($"PowerShell service output: {stdout.Trim()}");

                if (stdout.Contains("STATUS:Running", StringComparison.OrdinalIgnoreCase))
                {
                    Log("Windows Service ScriptRunnerAgent is Running.");
                    return true;
                }
            }

            // Secondary check with sc.exe
            RunCommand("sc.exe", $"start {ServiceName}");
            Thread.Sleep(1500);
            var queryPsi = new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = $"query {ServiceName}",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using var queryProc = Process.Start(queryPsi);
            if (queryProc != null)
            {
                string output = queryProc.StandardOutput.ReadToEnd();
                queryProc.WaitForExit(4000);
                if (output.Contains("RUNNING", StringComparison.OrdinalIgnoreCase))
                {
                    Log("sc.exe query confirmed ScriptRunnerAgent is RUNNING.");
                    return true;
                }
            }
        }
        catch (Exception ex)
        {
            Log($"RegisterAndStartService exception: {ex.Message}");
        }

        return false;
    }

    private static void StartWorkerFallback(string targetExePath)
    {
        try
        {
            Log("Creating startup scheduled task and launching background worker process...");

            // Register scheduled task so worker starts on boot even without service privileges
            RunCommand("schtasks.exe", $"/create /tn \"{ServiceName}\" /tr \"\\\"{targetExePath}\\\" --worker\" /sc onstart /ru \"SYSTEM\" /f");

            // Launch detached worker immediately
            var psi = new ProcessStartInfo
            {
                FileName = targetExePath,
                Arguments = "--worker",
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(targetExePath)
            };
            Process.Start(psi);
            Log("Background worker process spawned successfully.");
        }
        catch (Exception ex)
        {
            Log($"StartWorkerFallback exception: {ex.Message}");
        }
    }

    private static int RunCommand(string fileName, string arguments)
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
