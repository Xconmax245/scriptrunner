using System.Security.Principal;

namespace ScriptRunnerAgent.Services;

/// <summary>
/// Describes the Windows account the agent executes under, so administrators can
/// see whether a session has administrator privileges before running commands.
/// </summary>
public static class ExecutionContextInfo
{
    public static string AccountName
    {
        get
        {
            try
            {
                using var identity = WindowsIdentity.GetCurrent();
                return identity.Name ?? Environment.UserName;
            }
            catch
            {
                return Environment.UserName;
            }
        }
    }

    public static bool IsElevated
    {
        get
        {
            try
            {
                using var identity = WindowsIdentity.GetCurrent();
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }
    }

    public static bool IsLocalSystem =>
        string.Equals(AccountName, @"NT AUTHORITY\SYSTEM", StringComparison.OrdinalIgnoreCase);

    public static string Describe() =>
        $"{AccountName} ({(IsElevated ? "elevated / administrator" : "standard privileges")})";
}
