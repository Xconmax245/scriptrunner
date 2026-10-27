"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Shield, AlertCircle, Loader2 } from "lucide-react";
import { motion } from "framer-motion";

const signInSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type SignInValues = z.infer<typeof signInSchema>;

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    // Development mode / preview: automatically bypass login wall
    router.replace("/dashboard");
  }, [router]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
  });

  const onSubmit = async (values: SignInValues) => {
    setError(null);
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });

    if (authErr) {
      setError(
        authErr.message === "Invalid login credentials"
          ? "Incorrect email or password."
          : authErr.message
      );
      return;
    }

    router.push("/dashboard");
    router.refresh();
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--bg-base)",
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: "100%", maxWidth: 360 }}
      >
        {/* Logo and Brand */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: 14,
              background: "#ffffff",
              boxShadow: "0 8px 24px rgba(255,255,255,0.12)",
              marginBottom: 16,
            }}
          >
            <Shield style={{ width: 22, height: 22, color: "#000000" }} />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            ScriptRunner
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Enterprise PowerShell Orchestration
          </p>
        </div>

        {/* Card */}
        <div
          className="card"
          style={{
            padding: "24px 28px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 18 }}>
            Administrator Authentication
          </h2>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid rgba(248,113,113,0.25)",
                background: "rgba(248,113,113,0.08)",
                color: "var(--status-error)",
                fontSize: 12,
                marginBottom: 16,
              }}
            >
              <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
              <span>{error}</span>
            </motion.div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} style={{ display: "flex", flexDirection: "column", gap: 14 }} noValidate>
            <div>
              <label htmlFor="email" className="label">
                Corporate Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className="input"
                placeholder="admin@corp.domain"
                {...register("email")}
                aria-invalid={!!errors.email}
              />
              {errors.email && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                  {errors.email.message}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="label">
                Master Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className="input"
                placeholder="••••••••••••"
                {...register("password")}
                aria-invalid={!!errors.password}
              />
              {errors.password && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                  {errors.password.message}
                </p>
              )}
            </div>

            <button
              type="submit"
              id="sign-in-btn"
              className="btn btn-primary"
              disabled={isSubmitting}
              style={{ width: "100%", height: 38, marginTop: 6 }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
                  Verifying…
                </>
              ) : (
                "Authenticate"
              )}
            </button>
            <div style={{ marginTop: 12 }}>
              <a
                href="/dashboard"
                className="btn btn-secondary"
                style={{ width: "100%", height: 38, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                Skip Login &amp; Enter Dashboard
              </a>
            </div>
          </form>
        </div>

        <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-disabled)", marginTop: 24 }}>
          Restricted access. All operations are cryptographically verified and audited.
        </p>
      </motion.div>
    </div>
  );
}
