"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application error boundary caught error:", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#09090b",
        color: "#f4f4f5",
        fontFamily: "var(--font-inter, sans-serif)",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: "480px",
          width: "100%",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "16px",
          padding: "32px",
          boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "12px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 20px auto",
            color: "#f87171",
          }}
        >
          <AlertTriangle size={28} />
        </div>

        <h2 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>
          Something went wrong
        </h2>

        <p
          style={{
            fontSize: "13px",
            color: "#a1a1aa",
            lineHeight: "1.6",
            marginBottom: "24px",
          }}
        >
          {error?.message && !error.message.includes("digest")
            ? error.message
            : "A server-side connection issue occurred. If you just deployed to Vercel, ensure that NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured in your Vercel Project Settings."}
        </p>

        {error?.digest && (
          <div
            style={{
              fontSize: "11px",
              fontFamily: "monospace",
              color: "#71717a",
              background: "#09090b",
              padding: "8px 12px",
              borderRadius: "8px",
              marginBottom: "24px",
              border: "1px solid #27272a",
            }}
          >
            Error Code / Digest: {error.digest}
          </div>
        )}

        <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
          <button
            onClick={() => reset()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              background: "#2563eb",
              color: "#ffffff",
              border: "none",
              padding: "10px 18px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <RefreshCw size={14} /> Try again
          </button>

          <Link
            href="/dashboard"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              background: "#27272a",
              color: "#e4e4e7",
              border: "1px solid #3f3f46",
              padding: "10px 18px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            <Home size={14} /> Go to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
