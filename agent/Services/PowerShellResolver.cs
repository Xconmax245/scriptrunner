using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace ScriptRunnerAgent.Services;

public static class PowerShellResolver
{
    public static string Resolve(string? configuredPath = null, ILogger? logger = null)
    {
        // 1. Explicitly configured path in options
        if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
        {
            logger?.LogInformation("Using configured PowerShell binary: {Path}", configuredPath);
            return configuredPath;
        }

        var candidatePaths = new List<string>();

        // 2. Discover PowerShell Core (pwsh.exe) in PATH
        string? pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathEnv))
        {
            foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                try
                {
                    string pwshInPath = Path.Combine(dir, "pwsh.exe");
                    if (File.Exists(pwshInPath)) candidatePaths.Add(pwshInPath);
                }
                catch { }
            }
        }

        // 3. Standard Program Files and Program Files (x86) locations for PowerShell 7+
        string[] programFolders = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetEnvironmentVariable("ProgramW6432") ?? @"C:\Program Files"
        }.Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        foreach (var pf in programFolders)
        {
            candidatePaths.Add(Path.Combine(pf, @"PowerShell\7\pwsh.exe"));
            candidatePaths.Add(Path.Combine(pf, @"PowerShell\7-preview\pwsh.exe"));
            candidatePaths.Add(Path.Combine(pf, @"PowerShell\pwsh.exe"));
        }

        // 4. Registry lookup for PowerShell Core or Windows PowerShell if on Windows
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                using var hklm = Microsoft.Win32.Registry.LocalMachine;
                using var pwshCoreKey = hklm.OpenSubKey(@"SOFTWARE\Microsoft\PowerShellCore\InstalledVersions");
                if (pwshCoreKey != null)
                {
                    foreach (var subKeyName in pwshCoreKey.GetSubKeyNames())
                    {
                        using var verKey = pwshCoreKey.OpenSubKey(subKeyName);
                        var installDir = verKey?.GetValue("InstallDir") as string;
                        if (!string.IsNullOrEmpty(installDir))
                        {
                            candidatePaths.Add(Path.Combine(installDir, "pwsh.exe"));
                        }
                    }
                }

                using var psKey = hklm.OpenSubKey(@"SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell");
                var psPath = psKey?.GetValue("Path") as string;
                if (!string.IsNullOrEmpty(psPath))
                {
                    candidatePaths.Add(psPath);
                }
            }
            catch { }
        }

        // 5. Windows PowerShell 5.1 in System32 and SysWOW64
        string sysDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
        if (!string.IsNullOrEmpty(sysDir))
        {
            candidatePaths.Add(Path.Combine(sysDir, @"WindowsPowerShell\v1.0\powershell.exe"));
        }

        string? winDir = Environment.GetEnvironmentVariable("WINDIR") ?? @"C:\Windows";
        candidatePaths.Add(Path.Combine(winDir, @"System32\WindowsPowerShell\v1.0\powershell.exe"));
        candidatePaths.Add(Path.Combine(winDir, @"SysWOW64\WindowsPowerShell\v1.0\powershell.exe"));

        // 6. Search PATH for powershell.exe
        if (!string.IsNullOrEmpty(pathEnv))
        {
            foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                try
                {
                    string psInPath = Path.Combine(dir, "powershell.exe");
                    if (File.Exists(psInPath)) candidatePaths.Add(psInPath);
                }
                catch { }
            }
        }

        // Find the first candidate that exists
        foreach (var candidate in candidatePaths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (File.Exists(candidate))
            {
                logger?.LogInformation("Discovered PowerShell binary at: {Path}", candidate);
                return candidate;
            }
        }

        throw new FileNotFoundException("Could not find a valid PowerShell executable on this host. Checked pwsh.exe and powershell.exe in standard locations, registry, and PATH.");
    }
}
