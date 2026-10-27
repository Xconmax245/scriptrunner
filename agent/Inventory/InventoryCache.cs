using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Inventory;

/// <summary>
/// Holds the most recently collected inventory so monitors can evaluate
/// hardware/OS conditions without running WMI on every check.
/// </summary>
public sealed class InventoryCache
{
    private readonly object _gate = new();
    private HardwareInventory? _hardware;
    private OperatingSystemInventory? _os;
    private DateTimeOffset _hardwareAt = DateTimeOffset.MinValue;
    private DateTimeOffset _osAt = DateTimeOffset.MinValue;

    public void Set(HardwareInventory? hardware, OperatingSystemInventory? os)
    {
        lock (_gate)
        {
            if (hardware is not null)
            {
                _hardware = hardware;
                _hardwareAt = DateTimeOffset.UtcNow;
            }
            if (os is not null)
            {
                _os = os;
                _osAt = DateTimeOffset.UtcNow;
            }
        }
    }

    public HardwareInventory? Hardware
    {
        get { lock (_gate) return _hardware; }
    }

    public OperatingSystemInventory? Os
    {
        get { lock (_gate) return _os; }
    }

    public bool IsHardwareFresh(TimeSpan maxAge) =>
        Hardware is not null && DateTimeOffset.UtcNow - _hardwareAt <= maxAge;

    public bool IsOsFresh(TimeSpan maxAge) =>
        Os is not null && DateTimeOffset.UtcNow - _osAt <= maxAge;
}
