using System.Net.NetworkInformation;
using System.Net.Sockets;
using ScriptRunnerAgent.Models;

namespace ScriptRunnerAgent.Inventory;

/// <summary>
/// Inventories active network adapters, addresses, gateways and DNS servers.
/// Loopback adapters are excluded; virtual adapters are retained because they
/// meaningfully affect connectivity on many managed endpoints.
/// </summary>
public sealed class NetworkInventoryCollector
{
    public Task<NetworkInventory> CollectAsync(CancellationToken cancellationToken) =>
        Task.Run(() => Collect(cancellationToken), cancellationToken);

    private NetworkInventory Collect(CancellationToken cancellationToken)
    {
        var result = new NetworkInventory { CollectedAt = DateTimeOffset.UtcNow };
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                try
                {
                    var props = nic.GetIPProperties();
                    var adapter = new NetworkAdapterInventory
                    {
                        Name = nic.Name,
                        Description = nic.Description,
                        MacAddress = FormatMac(nic.GetPhysicalAddress()?.GetAddressBytes()),
                        Type = nic.NetworkInterfaceType.ToString(),
                        Status = nic.OperationalStatus.ToString(),
                        SpeedBitsPerSecond = nic.Speed > 0 ? nic.Speed : null
                    };

                    foreach (var address in props.UnicastAddresses)
                    {
                        if (address.Address.AddressFamily == AddressFamily.InterNetwork)
                        {
                            adapter.Ipv4.Add(address.Address.ToString());
                        }
                        else if (address.Address.AddressFamily == AddressFamily.InterNetworkV6)
                        {
                            adapter.Ipv6.Add(address.Address.ToString());
                        }
                    }

                    foreach (var gateway in props.GatewayAddresses)
                    {
                        if (gateway.Address is not null)
                        {
                            adapter.Gateways.Add(gateway.Address.ToString());
                        }
                    }

                    foreach (var dns in props.DnsAddresses)
                    {
                        adapter.DnsServers.Add(dns.ToString());
                    }

                    result.Interfaces.Add(adapter);
                }
                catch (Exception ex)
                {
                    result.Warnings.Add($"Adapter '{nic.Name}' could not be read: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            result.Warnings.Add("Network inventory failed: " + ex.Message);
        }

        return result;
    }

    private static string? FormatMac(byte[]? bytes)
    {
        if (bytes is null || bytes.Length == 0) return null;
        return string.Join(":", bytes.Select(b => b.ToString("X2")));
    }
}
