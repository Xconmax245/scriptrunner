using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using ScriptRunnerAgent.Configuration;
using ScriptRunnerAgent.Deployment;
using ScriptRunnerAgent.Installer;
using ScriptRunnerAgent.Inventory;
using ScriptRunnerAgent.Monitoring;
using ScriptRunnerAgent.Models;
using ScriptRunnerAgent.Services;
using ScriptRunnerAgent.Worker;

namespace ScriptRunnerAgent;

internal static class Program
{
    [STAThread]
    private static async Task Main(string[] args)
    {
        bool isInstallMode = args.Contains("--install", StringComparer.OrdinalIgnoreCase);
        bool isUninstallMode = args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase);

        if (isUninstallMode)
        {
            if (!AgentInstaller.IsAdministrator())
            {
                AgentInstaller.RelaunchAsAdministrator(args);
                return;
            }

            Process.Start(new ProcessStartInfo("sc.exe", "stop ScriptRunnerAgent") { CreateNoWindow = true, UseShellExecute = false })?.WaitForExit();
            Process.Start(new ProcessStartInfo("sc.exe", "delete ScriptRunnerAgent") { CreateNoWindow = true, UseShellExecute = false })?.WaitForExit();
            return;
        }

        if (isInstallMode)
        {
            if (!AgentInstaller.IsAdministrator())
            {
                AgentInstaller.RelaunchAsAdministrator(args);
                return;
            }

            ApplicationConfiguration.Initialize();
            Application.Run(new InstallationForm());
            return;
        }

        // Standard worker execution mode (both interactive console and Windows Service)
        const string MutexName = @"Global\ScriptRunnerAgent_SingleInstance_Mutex";
        using var singleInstanceMutex = new Mutex(initiallyOwned: true, MutexName, out bool isOnlyInstance);
        if (!isOnlyInstance)
        {
            Console.WriteLine("[ScriptRunnerAgent] Another instance is already running.");
            return;
        }

        var builder = Host.CreateDefaultBuilder(args)
            .UseContentRoot(AppContext.BaseDirectory)
            .UseWindowsService(options =>
            {
                options.ServiceName = "ScriptRunnerAgent";
            })
            .ConfigureServices((hostContext, services) =>
            {
                // Bind configuration
                services.Configure<AgentOptions>(
                    hostContext.Configuration.GetSection(AgentOptions.SectionName));

                // Typed HTTP client for Supabase Edge Functions
                services.AddHttpClient<ISupabaseApiClient, SupabaseApiClient>(client =>
                {
                    client.Timeout = TimeSpan.FromSeconds(90);
                });

                // Local device identity (self-generated device ID + install ID)
                services.AddSingleton<IDeviceIdentityStore, DeviceIdentityStore>();

                // Automatic enrollment / authorization gate
                services.AddSingleton<EnrollmentService>();

                // Script execution engine & state persistence
                services.AddSingleton<IJobExecutionEngine, JobExecutionEngine>();
                services.AddSingleton<IStatePersistenceManager, StatePersistenceManager>();

                // RMM: inventory, telemetry, monitoring, software deployment
                services.AddSingleton<AgentRuntimeState>();
                services.AddSingleton<InventoryCache>();
                services.AddSingleton<HardwareInventoryCollector>();
                services.AddSingleton<OperatingSystemInventoryCollector>();
                services.AddSingleton<NetworkInventoryCollector>();
                services.AddSingleton<SoftwareInventoryCollector>();
                services.AddSingleton<SystemMetricsCollector>();
                services.AddSingleton<RmmStateStore>();
                services.AddSingleton<EventLogScanner>();
                services.AddSingleton<MonitorRunner>();
                services.AddSingleton<SoftwareDeploymentExecutor>();

                // Background workers: queued jobs + interactive remote terminal + RMM
                services.AddHostedService<AgentWorkerService>();
                services.AddHostedService<TerminalWorkerService>();
                services.AddHostedService<RmmWorkerService>();
            })
            .ConfigureLogging(logging =>
            {
                logging.ClearProviders();
                logging.AddConsole();

                if (WindowsServiceHelpers.IsWindowsService())
                {
                    logging.AddEventLog(settings =>
                    {
                        settings.SourceName = "ScriptRunnerAgent";
                    });
                }

                logging.SetMinimumLevel(LogLevel.Information);
            });

        var host = builder.Build();
        await host.RunAsync();
    }
}
