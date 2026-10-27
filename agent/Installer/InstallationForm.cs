using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ScriptRunnerAgent.Installer;

public sealed class InstallationForm : Form
{
    private readonly Label _headerLabel;
    private readonly Label _subtitleLabel;
    private readonly ProgressBar _progressBar;
    private readonly Label _statusLabel;

    public InstallationForm()
    {
        Text = "ScriptRunner Endpoint Setup";
        ClientSize = new Size(500, 200);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(24, 24, 27);
        ForeColor = Color.FromArgb(244, 244, 245);
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        // Header label
        _headerLabel = new Label
        {
            Text = "Installing ScriptRunner Endpoint Agent",
            Font = new Font("Segoe UI", 12F, FontStyle.Bold, GraphicsUnit.Point),
            ForeColor = Color.FromArgb(250, 250, 250),
            Location = new Point(28, 24),
            Size = new Size(440, 28),
            AutoEllipsis = true
        };

        // Subtitle label
        _subtitleLabel = new Label
        {
            Text = "Configuring secure background service and endpoint connectivity...",
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point),
            ForeColor = Color.FromArgb(161, 161, 170),
            Location = new Point(28, 54),
            Size = new Size(440, 20),
            AutoEllipsis = true
        };

        // Progress bar
        _progressBar = new ProgressBar
        {
            Location = new Point(28, 88),
            Size = new Size(444, 20),
            Minimum = 0,
            Maximum = 100,
            Value = 5,
            Style = ProgressBarStyle.Continuous
        };

        // Status step label
        _statusLabel = new Label
        {
            Text = "Initializing installation...",
            Font = new Font("Segoe UI", 8.5F, FontStyle.Regular, GraphicsUnit.Point),
            ForeColor = Color.FromArgb(212, 212, 216),
            Location = new Point(28, 120),
            Size = new Size(444, 40),
            AutoEllipsis = true
        };

        Controls.Add(_headerLabel);
        Controls.Add(_subtitleLabel);
        Controls.Add(_progressBar);
        Controls.Add(_statusLabel);

        Shown += OnFormShown;
    }

    private async void OnFormShown(object? sender, EventArgs e)
    {
        try
        {
            await Task.Delay(300); // Smooth initial transition
            bool success = await AgentInstaller.InstallAsync(UpdateProgress);

            if (success)
            {
                UpdateProgress(100, "Installation complete.");
                await Task.Delay(500); // Brief visual confirmation at 100%
                Close();
                Environment.Exit(0);
            }
            else
            {
                UpdateProgress(_progressBar.Value, "Installation failed. Check system permissions.");
            }
        }
        catch (Exception ex)
        {
            _statusLabel.ForeColor = Color.FromArgb(248, 113, 113);
            _statusLabel.Text = $"Error: {ex.Message}";
        }
    }

    private void UpdateProgress(int percent, string message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => UpdateProgress(percent, message)));
            return;
        }

        _progressBar.Value = Math.Clamp(percent, 0, 100);
        _statusLabel.Text = message;
    }
}
