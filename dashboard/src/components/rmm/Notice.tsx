export function Notice({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;

  return (
    <div
      role={error ? "alert" : "status"}
      style={{
        padding: "10px 14px",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${error ? "rgba(248,113,113,0.25)" : "rgba(52,211,153,0.25)"}`,
        background: error ? "rgba(248,113,113,0.08)" : "rgba(52,211,153,0.08)",
        color: error ? "var(--status-error)" : "var(--status-online)",
        fontSize: 12.5,
        marginBottom: 16,
      }}
    >
      {error ?? message}
    </div>
  );
}
