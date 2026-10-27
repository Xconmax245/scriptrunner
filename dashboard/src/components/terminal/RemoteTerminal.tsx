"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Circle,
  Loader2,
  Plug,
  Power,
  ShieldAlert,
  Terminal as TerminalIcon,
  Wifi,
  WifiOff,
} from "lucide-react";

interface Props {
  deviceId: string;
  deviceName: string;
  hostname: string | null;
  canManage: boolean;
}

interface SessionInfo {
  id: string;
  hostname: string | null;
  deviceName: string | null;
  createdAt: string;
  expiresAt: string;
}

type TerminalStatus =
  | "idle"
  | "starting"
  | "waiting-for-agent"
  | "active"
  | "reconnecting"
  | "ended"
  | "error";

const COMPLETION_PREFIX = "\u0001SR-COMPLETIONS\u0001";
const MAX_OUTPUT_CHARS = 400_000;

interface CommandState {
  sequence: number;
  completed?: boolean;
  exitOk?: boolean | null;
  error?: string | null;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

export function RemoteTerminal({ deviceId, deviceName, hostname, canManage }: Props) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<number, CommandState>>({});
  const [now, setNow] = useState(() => Date.now());

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const cursorRef = useRef(0);
  const completionsRef = useRef<string[]>([]);
  const sessionRef = useRef<SessionInfo | null>(null);
  const statusRef = useRef<TerminalStatus>("idle");
  const commandStatesRef = useRef<Record<number, CommandState>>({});

  sessionRef.current = session;
  statusRef.current = status;
  commandStatesRef.current = commands;

  const targetHost = session?.hostname ?? hostname ?? deviceName;
  const isLive = status === "active" || status === "reconnecting" || status === "waiting-for-agent";

  const appendText = useCallback((text: string) => {
    if (!text) return;
    setOutput((previous) => {
      const combined = previous + stripAnsi(text);
      return combined.length > MAX_OUTPUT_CHARS
        ? combined.slice(combined.length - MAX_OUTPUT_CHARS)
        : combined;
    });
  }, []);

  const appendSystem = useCallback(
    (text: string) => appendText(`\r\n\x1b[90m${text}\x1b[0m\r\n`),
    [appendText]
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = outputRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 120) {
      element.scrollTop = element.scrollHeight;
    }
  }, [output]);

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const attachStream = useCallback(
    (sessionId: string, after: number) => {
      closeStream();
      const source = new EventSource(
        `/api/terminal/sessions/${sessionId}/stream?after=${after}`
      );
      sourceRef.current = source;

      source.addEventListener("ready", (event) => {
        const payload = JSON.parse((event as MessageEvent).data);
        setSession((current) =>
          current
            ? {
                ...current,
                hostname: payload.session.hostname ?? current.hostname,
                createdAt: payload.session.created_at ?? current.createdAt,
                expiresAt: payload.session.expires_at ?? current.expiresAt,
              }
            : current
        );
        if (payload.session.status === "active") setStatus("active");
        else if (payload.session.status === "pending") setStatus("waiting-for-agent");
        else {
          setStatus("ended");
          setCloseReason(payload.session.close_reason ?? null);
        }
      });

      source.addEventListener("output", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          items: { sequence: number; stream: string; content: string }[];
        };

        for (const item of payload.items) {
          cursorRef.current = Math.max(cursorRef.current, Number(item.sequence));
          if (item.content.startsWith(COMPLETION_PREFIX)) {
            try {
              const names = JSON.parse(item.content.slice(COMPLETION_PREFIX.length));
              if (Array.isArray(names)) {
                completionsRef.current = names
                  .filter((n): n is string => typeof n === "string")
                  .slice(0, 3000);
              }
            } catch {
              // ignore malformed metadata
            }
            continue;
          }
          appendText(item.content);
        }
        setStatus((current) => (current === "waiting-for-agent" ? "active" : current));
      });

      source.addEventListener("status", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          status: string;
          close_reason: string | null;
        };
        if (payload.status === "pending") setStatus("waiting-for-agent");
        else if (payload.status === "active") {
          setStatus((current) => (current === "reconnecting" ? "active" : current));
        } else if (payload.status === "suspended") {
          setStatus("ended");
        } else if (["closed", "expired", "revoked"].includes(payload.status)) {
          setStatus("ended");
          setCloseReason(payload.close_reason);
        }
      });

      source.addEventListener("commands", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          items: { sequence: number; completed_at: string | null; exit_ok: boolean | null; error_summary: string | null }[];
        };

        const next: Record<number, CommandState> = { ...commandStatesRef.current };
        for (const item of payload.items) {
          const sequence = Number(item.sequence);
          const previous = next[sequence];
          const completed = Boolean(item.completed_at);
          next[sequence] = {
            sequence,
            completed,
            exitOk: item.exit_ok,
            error: item.error_summary,
          };
          if (completed && !previous?.completed) {
            appendSystem(
              item.exit_ok === false
                ? `[command ${sequence} finished with errors${item.error_summary ? `: ${item.error_summary}` : ""}]`
                : `[command ${sequence} completed]`
            );
          }
        }
        setCommands(next);
      });

      source.addEventListener("end", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          status: string;
          close_reason: string | null;
        };
        setStatus("ended");
        setCloseReason(payload.close_reason ?? null);
        closeStream();
      });

      source.addEventListener("error", () => {
        if (source.readyState === EventSource.CLOSED) {
          setStatus((current) => (current === "ended" ? current : "reconnecting"));
        } else {
          setStatus((current) => (current === "ended" ? current : "reconnecting"));
        }
      });

      source.onopen = () => {
        setStatus((current) =>
          current === "reconnecting" ? "active" : current === "ended" ? current : current
        );
      };
    },
    [appendSystem, appendText, closeStream]
  );

  const startSession = useCallback(async () => {
    setError(null);
    setStatus("starting");
    setOutput("");
    cursorRef.current = 0;
    completionsRef.current = [];
    setCommands({});
    commandStatesRef.current = {};

    try {
      const response = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus("error");
        setError(payload.error ?? "Could not open a terminal session");
        return;
      }

      const info: SessionInfo = {
        id: payload.session.id,
        hostname: payload.session.hostname ?? hostname,
        deviceName: payload.session.device_name ?? deviceName,
        createdAt: new Date().toISOString(),
        expiresAt: payload.session.expires_at,
      };
      setSession(info);
      setStatus("waiting-for-agent");
      setCloseReason(null);
      appendSystem(
        `Requesting a remote session on ${info.hostname ?? deviceName}…`
      );
      attachStream(info.id, 0);
      inputRef.current?.focus();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Network error");
    }
  }, [appendSystem, attachStream, deviceId, deviceName, hostname]);

  const disconnect = useCallback(async () => {
    const current = sessionRef.current;
    closeStream();
    if (!current) {
      setStatus("idle");
      return;
    }
    try {
      await fetch(`/api/terminal/sessions/${current.id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Disconnected by administrator" }),
        keepalive: true,
      });
    } catch {
      // best effort
    }
    setStatus("ended");
    setCloseReason("Disconnected by administrator");
    appendSystem("Disconnected.");
  }, [appendSystem, closeStream]);

  // Close the session if the operator navigates away.
  useEffect(() => {
    return () => {
      const current = sessionRef.current;
      closeStream();
      if (current && (statusRef.current === "active" || statusRef.current === "waiting-for-agent")) {
        void fetch(`/api/terminal/sessions/${current.id}/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Administrator left the terminal" }),
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [closeStream]);

  const completeInput = useCallback(() => {
    const value = command;
    const match = /([A-Za-z0-9_\-]+)$/.exec(value);
    if (!match) return;
    const token = match[1].toLowerCase();
    const candidates = completionsRef.current.filter((name) =>
      name.toLowerCase().startsWith(token)
    );
    if (candidates.length === 0) return;

    const prefix = value.slice(0, value.length - match[1].length);
    if (candidates.length === 1) {
      setCommand(prefix + candidates[0] + " ");
      return;
    }

    // Complete to the longest common prefix, and show the candidate set.
    let common = candidates[0];
    for (const candidate of candidates) {
      while (!candidate.toLowerCase().startsWith(common.toLowerCase())) {
        common = common.slice(0, -1);
        if (!common) break;
      }
    }
    if (common.length > match[1].length) {
      setCommand(prefix + common);
    }
    appendSystem(
      `${candidates.length} completions: ${candidates.slice(0, 24).join("  ")}${
        candidates.length > 24 ? "  …" : ""
      }`
    );
  }, [appendSystem, command]);

  const submitCommand = useCallback(async () => {
    const current = sessionRef.current;
    const text = command.trim();
    if (!current || !text || status === "ended" || status === "error") return;

    setCommand("");
    setHistory((previous) => [...previous, text].slice(-200));
    setHistoryIndex(null);
    appendText(`\r\n\x1b[36mPS> ${text}\x1b[0m\r\n`);

    try {
      const response = await fetch(`/api/terminal/sessions/${current.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });
      const payload = await response.json();
      if (!response.ok) {
        appendSystem(`[not executed] ${payload.error ?? "Command rejected"}`);
        if (response.status === 409) {
          setStatus("ended");
          setCloseReason(payload.error ?? null);
        }
        return;
      }
      const sequence = Number(payload.sequence);
      setCommands((previous) => ({
        ...previous,
        [sequence]: { sequence, completed: false },
      }));
    } catch (err) {
      appendSystem(
        `[transport error] ${err instanceof Error ? err.message : "Could not send command"}`
      );
    }
  }, [appendSystem, appendText, command, status]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCommand();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      completeInput();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const nextIndex =
        historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setCommand(history[nextIndex]);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        setCommand("");
      } else {
        setHistoryIndex(nextIndex);
        setCommand(history[nextIndex]);
      }
      return;
    }

    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setOutput("");
    }
  };

  const statusView = useMemo(() => {
    switch (status) {
      case "starting":
        return { label: "Opening session…", className: "badge bg-amber-950/60 text-amber-300 border border-amber-800", icon: Loader2, spin: true };
      case "waiting-for-agent":
        return { label: "Waiting for agent", className: "badge bg-amber-950/60 text-amber-300 border border-amber-800", icon: Wifi, spin: false };
      case "active":
        return { label: "Attached", className: "badge bg-emerald-950/60 text-emerald-300 border border-emerald-800", icon: Wifi, spin: false };
      case "reconnecting":
        return { label: "Reconnecting…", className: "badge bg-amber-950/60 text-amber-300 border border-amber-800", icon: WifiOff, spin: false };
      case "ended":
        return { label: "Session ended", className: "badge bg-gray-800 text-gray-300 border border-gray-700", icon: Power, spin: false };
      case "error":
        return { label: "Error", className: "badge bg-red-950/60 text-red-300 border border-red-800", icon: ShieldAlert, spin: false };
      default:
        return { label: "Not connected", className: "badge bg-gray-800 text-gray-400 border border-gray-700", icon: Circle, spin: false };
    }
  }, [status]);

  const StatusIcon = statusView.icon;
  const expiresInMinutes = session
    ? Math.max(0, Math.round((new Date(session.expiresAt).getTime() - now) / 60000))
    : null;
  const pendingCommands = Object.values(commands).filter((c) => !c.completed).length;
  const lastCommand = Object.values(commands).sort((a, b) => b.sequence - a.sequence)[0];

  if (!canManage) {
    return (
      <div className="card p-8 text-center space-y-3">
        <ShieldAlert className="mx-auto h-10 w-10 text-amber-500" />
        <h2 className="text-lg font-semibold text-white">Administrator sign-in required</h2>
        <p className="text-sm text-gray-400 max-w-md mx-auto">
          Remote terminal sessions require an authenticated owner or administrator of
          this organization. Command execution and session access are audited.
        </p>
        <a href={`/auth/sign-in?next=/dashboard/devices/${deviceId}/terminal`} className="btn-primary inline-flex">
          Sign in as administrator
        </a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100, margin: "0 auto" }}>
      {/* Hostname banner */}
      <div className="card" style={{ padding: "24px 28px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>
                Remote PowerShell Terminal
              </p>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", letterSpacing: "-0.02em", marginTop: 4 }}>
                {targetHost}
              </h1>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
                Target: <span style={{ color: "var(--text-secondary)" }}>{deviceName}</span> &middot; Non-interactive worker session
              </p>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <span className={statusView.className}>
                <StatusIcon className={`h-3.5 w-3.5 ${statusView.spin ? "animate-spin" : ""}`} />
                {statusView.label}
              </span>
              {session && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
                  session {session.id.slice(0, 8)} &middot; {expiresInMinutes}m left
                </span>
              )}
              {!session || status === "ended" || status === "error" ? (
                <button
                  onClick={() => void startSession()}
                  className="btn btn-primary btn-sm"
                  disabled={status === "starting"}
                  id="terminal-connect-btn"
                >
                  <Plug style={{ width: 13, height: 13 }} />
                  {session ? "Reconnect" : "Open Session"}
                </button>
              ) : (
                <button onClick={() => void disconnect()} className="btn btn-secondary btn-sm" id="terminal-disconnect-btn">
                  <Power style={{ width: 13, height: 13 }} />
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid rgba(248,113,113,0.25)",
            background: "rgba(248,113,113,0.08)",
            color: "var(--status-error)",
            fontSize: 12,
          }}
        >
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {status === "ended" && closeReason && (
        <div className="card" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-secondary)" }}>
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>Session terminated:</span> {closeReason}
        </div>
      )}

      {status === "waiting-for-agent" && (
        <div
          style={{
            borderRadius: "var(--radius-md)",
            border: "1px solid rgba(251,191,36,0.25)",
            background: "rgba(251,191,36,0.08)",
            padding: "12px 16px",
            fontSize: 12,
            color: "var(--status-warning)",
          }}
        >
          Session created. Waiting for ScriptRunnerAgent on <span style={{ fontFamily: "monospace" }}>{targetHost}</span> to connect.
        </div>
      )}

      {/* Terminal Window with Apple window dots */}
      <div
        className="card"
        style={{
          overflow: "hidden",
          background: "#080808",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
            padding: "10px 16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Apple window dots */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f56", display: "inline-block" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ffbd2e", display: "inline-block" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#27c93f", display: "inline-block" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)" }}>
              <TerminalIcon style={{ width: 13, height: 13, color: "var(--text-secondary)" }} />
              <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{targetHost}</span>
              <span>&middot;</span>
              <span>PowerShell Core</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
            {pendingCommands > 0 && <span style={{ color: "var(--status-warning)" }}>running…</span>}
            {lastCommand?.completed && (
              <span style={{ color: lastCommand.exitOk === false ? "var(--status-error)" : "var(--status-online)" }}>
                exit: {lastCommand.exitOk === false ? "error" : "ok"}
              </span>
            )}
            <span>{output.length.toLocaleString()} chars</span>
          </div>
        </div>

        <div
          ref={outputRef}
          className="h-[55vh] min-h-[320px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed text-gray-200"
          aria-label="Terminal output"
          tabIndex={0}
        >
          {output || (
            <span className="text-gray-500">
              {session
                ? "Waiting for output…"
                : "No session yet. Open a session to start an interactive PowerShell terminal on this target."}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-gray-800 bg-gray-900/80 px-4 py-2">
          <span className="font-mono text-xs text-emerald-400">PS&gt;</span>
          <input
            ref={inputRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={!isLive}
            placeholder={
              isLive ? "Enter a PowerShell command (Tab completes, ↑/↓ history)" : "Open a session to type commands"
            }
            className="flex-1 bg-transparent font-mono text-[13px] text-gray-100 placeholder:text-gray-600 focus:outline-none disabled:opacity-50"
            spellCheck={false}
            autoComplete="off"
            id="terminal-command-input"
            aria-label="PowerShell command"
          />
          <button
            onClick={() => void submitCommand()}
            disabled={!isLive || !command.trim()}
            className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
            id="terminal-run-btn"
          >
            Run
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-500">
        Commands execute noninteractively in the service account context. Commands that
        require desktop input or missing privileges are reported instead of hanging.
        Session activity and every command are written to the audit log.
      </p>
    </div>
  );
}
