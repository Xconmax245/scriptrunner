"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Terminal as TerminalIcon,
  Play,
  RotateCcw,
  Maximize2,
  Minimize2,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Laptop,
  ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface Device {
  id: string;
  display_name: string;
  hostname: string | null;
  operating_system?: string | null;
  isOnline?: boolean;
}

interface CommandEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timestamp: string;
  promptPath: string;
}

interface Props {
  devices?: Device[];
  initialDeviceId?: string;
  embedded?: boolean;
}

const QUICK_COMMANDS = [
  { label: "whoami", cmd: "whoami" },
  { label: "Hostname", cmd: "hostname" },
  { label: "Get-Date", cmd: "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'" },
  { label: "PS Version", cmd: "$PSVersionTable.PSVersion" },
  { label: "Agent Service", cmd: "Get-Service ScriptRunnerAgent -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType" },
  { label: "Directory Listing", cmd: "Get-ChildItem -Name | Select-Object -First 10" },
  { label: "Top Processes", cmd: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 6 Name, Id, CPU" },
];

export function WorkingTerminal({ devices = [], initialDeviceId, embedded = false }: Props) {
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(() => {
    if (initialDeviceId) {
      const match = devices.find((d) => d.id === initialDeviceId);
      if (match) return match;
    }
    return devices[0] || {
      id: "b37a3eb0-8e39-4c5b-8c86-38d68a4bf379",
      display_name: "Test Prospective Target PC",
      hostname: "TARGET-DESKTOP-01",
      operating_system: "Microsoft Windows 11 Enterprise",
      isOnline: true,
    };
  });

  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [entries, setEntries] = useState<CommandEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [deviceDropdownOpen, setDeviceDropdownOpen] = useState(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);

  const hostname = selectedDevice?.hostname || selectedDevice?.display_name || "TARGET-HOST";
  const promptText = `PS ${hostname}> `;

  const scrollToBottom = useCallback(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [entries, executing, scrollToBottom]);

  // Initial welcome message
  useEffect(() => {
    const bannerEntry: CommandEntry = {
      id: "init-banner",
      command: "# ScriptRunner Remote PowerShell Core v7.4 / Windows PowerShell 5.1",
      stdout: `Connected to endpoint [${hostname}] over secure mutual TLS channel.
Operating System: ${selectedDevice?.operating_system || "Windows 11 Enterprise (x64)"}
Agent Worker: ScriptRunnerAgent v1.0.0 (Elevated Privileges)
Type any PowerShell cmdlet, batch command, or executable. Press Tab for completion, Up/Down for command history.`,
      stderr: "",
      exitCode: 0,
      durationMs: 12,
      timestamp: new Date().toLocaleTimeString(),
      promptPath: promptText,
    };
    setEntries([bannerEntry]);
  }, [hostname, selectedDevice?.operating_system, promptText]);

  const executeCommand = async (cmdToRun: string) => {
    const trimmed = cmdToRun.trim();
    if (!trimmed || executing) return;

    if (trimmed.toLowerCase() === "cls" || trimmed.toLowerCase() === "clear") {
      setEntries([]);
      setCommand("");
      return;
    }

    setExecuting(true);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    setCommand("");

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: trimmed,
          device_id: selectedDevice?.id,
        }),
      });

      const data = await res.json();

      const newEntry: CommandEntry = {
        id: Math.random().toString(36).substring(2, 9),
        command: trimmed,
        stdout: data.stdout || "",
        stderr: data.stderr || (data.error ? String(data.error) : ""),
        exitCode: typeof data.exitCode === "number" ? data.exitCode : data.error ? 1 : 0,
        durationMs: data.durationMs || 100,
        timestamp: new Date().toLocaleTimeString(),
        promptPath: promptText,
      };

      setEntries((prev) => [...prev, newEntry]);
    } catch (err: any) {
      const errorEntry: CommandEntry = {
        id: Math.random().toString(36).substring(2, 9),
        command: trimmed,
        stdout: "",
        stderr: err.message || "Failed to communicate with remote endpoint.",
        exitCode: 1,
        durationMs: 0,
        timestamp: new Date().toLocaleTimeString(),
        promptPath: promptText,
      };
      setEntries((prev) => [...prev, errorEntry]);
    } finally {
      setExecuting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void executeCommand(command);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIdx);
      setCommand(history[nextIdx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      const nextIdx = historyIndex + 1;
      if (nextIdx >= history.length) {
        setHistoryIndex(-1);
        setCommand("");
      } else {
        setHistoryIndex(nextIdx);
        setCommand(history[nextIdx]);
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const current = command.toLowerCase();
      const match = QUICK_COMMANDS.find((q) => q.cmd.toLowerCase().startsWith(current));
      if (match) {
        setCommand(match.cmd);
      }
    }
  };

  const focusInput = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        width: "100%",
        position: isMaximized ? "fixed" : "relative",
        inset: isMaximized ? 0 : "auto",
        zIndex: isMaximized ? 9999 : "auto",
        background: isMaximized ? "#000000" : "transparent",
        padding: isMaximized ? 24 : 0,
      }}
    >
      {/* Top Bar Controls */}
      <div
        className="card"
        style={{
          padding: "10px 16px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          background: "var(--bg-elevated)",
        }}
      >
        {/* Device selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: devices.length > 1 ? "pointer" : "default",
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-subtle)",
            }}
            onClick={() => devices.length > 1 && setDeviceDropdownOpen(!deviceDropdownOpen)}
          >
            <Laptop style={{ width: 14, height: 14, color: "var(--text-secondary)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", fontFamily: "monospace" }}>
              {hostname}
            </span>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--status-online)",
                boxShadow: "0 0 8px rgba(52,211,153,0.5)",
              }}
            />
            {devices.length > 1 && <ChevronDown style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />}
          </div>

          {/* Dropdown for device selection if multiple devices */}
          {deviceDropdownOpen && devices.length > 1 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 6,
                width: 240,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                boxShadow: "var(--shadow-lg)",
                zIndex: 50,
                overflow: "hidden",
              }}
            >
              {devices.map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setSelectedDevice(d);
                    setDeviceDropdownOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    background: selectedDevice?.id === d.id ? "var(--bg-hover)" : "transparent",
                    color: "var(--text-primary)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontFamily: "monospace" }}>{d.hostname || d.display_name}</span>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: d.isOnline !== false ? "var(--status-online)" : "var(--status-offline)",
                    }}
                  />
                </button>
              ))}
            </div>
          )}

          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            Privileges: <strong style={{ color: "var(--text-primary)" }}>SYSTEM</strong> &middot; Protocol: <strong>RPC</strong>
          </span>
        </div>

        {/* Action icons */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => setEntries([])}
            className="btn btn-ghost btn-sm"
            title="Clear terminal screen (Ctrl+L)"
          >
            <Trash2 style={{ width: 12, height: 12 }} />
            Clear
          </button>
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="btn btn-ghost btn-sm"
            title={isMaximized ? "Restore" : "Full Screen"}
          >
            {isMaximized ? <Minimize2 style={{ width: 12, height: 12 }} /> : <Maximize2 style={{ width: 12, height: 12 }} />}
          </button>
        </div>
      </div>

      {/* Terminal Window Frame */}
      <div
        ref={terminalContainerRef}
        onClick={focusInput}
        style={{
          borderRadius: 14,
          border: "1px solid var(--border-strong)",
          background: "#050505",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          height: isMaximized ? "calc(100vh - 120px)" : embedded ? 440 : 540,
          overflow: "hidden",
          cursor: "text",
        }}
      >
        {/* Terminal Titlebar (Apple Mac style) */}
        <div
          style={{
            height: 38,
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background: "linear-gradient(180deg, #161616 0%, #101010 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 14px",
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f56", display: "inline-block" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffbd2e", display: "inline-block" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#27c93f", display: "inline-block" }} />
            <span style={{ marginLeft: 10, fontSize: 11, color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
              <TerminalIcon style={{ width: 12, height: 12, color: "var(--text-secondary)" }} />
              <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>PowerShell Interactive Console</span>
              <span>&mdash;</span>
              <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{hostname}</span>
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-tertiary)" }}>
            <span style={{ fontFamily: "monospace" }}>UTF-8</span>
          </div>
        </div>

        {/* Terminal Body / Output Stream */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 12.5,
            lineHeight: 1.6,
            color: "#e5e5e5",
          }}
        >
          {entries.map((entry) => (
            <div key={entry.id} style={{ marginBottom: 14 }}>
              {/* Command Prompt Line */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#ffffff", fontWeight: 600 }}>
                <span style={{ color: "#34d399", userSelect: "none" }}>{entry.promptPath}</span>
                <span style={{ color: "#ffffff", wordBreak: "break-all" }}>{entry.command}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-disabled)", fontWeight: 400, userSelect: "none" }}>
                  {entry.durationMs > 0 && `${entry.durationMs}ms`} &middot; {entry.timestamp}
                </span>
              </div>

              {/* Stdout Output */}
              {entry.stdout && (
                <div
                  style={{
                    marginTop: 4,
                    color: "#d4d4d4",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {entry.stdout}
                </div>
              )}

              {/* Stderr Output */}
              {entry.stderr && (
                <div
                  style={{
                    marginTop: 4,
                    color: "#f87171",
                    background: "rgba(248,113,113,0.06)",
                    padding: "6px 10px",
                    borderRadius: 4,
                    borderLeft: "2px solid #f87171",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {entry.stderr}
                </div>
              )}
            </div>
          ))}

          {/* Currently executing indicator */}
          {executing && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--status-warning)", margin: "8px 0" }}>
              <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
              <span style={{ fontSize: 12 }}>Executing on {hostname}…</span>
            </div>
          )}

          {/* Active Command Input Line */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <span style={{ color: "#34d399", fontWeight: 600, userSelect: "none" }}>{promptText}</span>
            <input
              ref={inputRef}
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={executing}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#ffffff",
                fontFamily: "inherit",
                fontSize: "inherit",
                padding: 0,
                caretColor: "#34d399",
              }}
              placeholder={executing ? "Processing…" : "Type a command and press Enter (or use quick badges below)"}
            />
          </div>

          <div ref={terminalEndRef} />
        </div>

        {/* Quick Action Chips at bottom of terminal */}
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(12,12,12,0.9)",
            padding: "8px 14px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)", whiteSpace: "nowrap", marginRight: 4 }}>
            Quick Run:
          </span>
          {QUICK_COMMANDS.map((q) => (
            <button
              key={q.label}
              onClick={() => {
                setCommand(q.cmd);
                void executeCommand(q.cmd);
              }}
              disabled={executing}
              style={{
                background: "var(--bg-overlay)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: "3px 8px",
                fontSize: 11,
                color: "var(--text-secondary)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                fontFamily: "monospace",
                transition: "all 120ms",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.borderColor = "var(--border-default)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-secondary)";
                e.currentTarget.style.background = "var(--bg-overlay)";
                e.currentTarget.style.borderColor = "var(--border-subtle)";
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
