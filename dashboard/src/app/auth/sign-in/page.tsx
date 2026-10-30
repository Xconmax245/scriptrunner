"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Shield,
  AlertCircle,
  Loader2,
  Mail,
  Lock,
  Eye,
  EyeOff,
  KeyRound,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const signInSchema = z.object({
  email: z.string().email("Enter a valid corporate email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  rememberMe: z.boolean().optional(),
});

type SignInValues = z.infer<typeof signInSchema>;

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/dashboard";

  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [filledFeedback, setFilledFeedback] = useState(false);
  const supabase = createClient();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
      rememberMe: true,
    },
  });

  const handleQuickFill = () => {
    setValue("email", "admin@scriptrunner.internal", { shouldValidate: true });
    setValue("password", "ScriptRunner2026!", { shouldValidate: true });
    setFilledFeedback(true);
    setError(null);
    setTimeout(() => setFilledFeedback(false), 2500);
  };

  const onSubmit = async (values: SignInValues) => {
    setError(null);
    try {
      const { data, error: authErr } = await supabase.auth.signInWithPassword({
        email: values.email.trim(),
        password: values.password,
      });

      if (authErr) {
        if (
          authErr.message === "Invalid login credentials" ||
          authErr.message.toLowerCase().includes("invalid")
        ) {
          setError("Invalid corporate credentials. Check email and password.");
        } else {
          setError(authErr.message);
        }
        return;
      }

      if (data.session) {
        // Successful login
        const destination = returnUrl.startsWith("/dashboard") ? returnUrl : "/dashboard";
        router.push(destination);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        background: "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(56,189,248,0.12), transparent 70%), var(--bg-base)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Ambient background grid lines */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(to right, rgba(255, 255, 255, 0.02) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          pointerEvents: "none",
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: "100%", maxWidth: 440, position: "relative", zIndex: 1 }}
      >
        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 52,
              height: 52,
              borderRadius: 16,
              background: "linear-gradient(135deg, #ffffff 0%, #d4d4d8 100%)",
              boxShadow: "0 12px 32px rgba(255,255,255,0.16), 0 0 0 1px rgba(255,255,255,0.2)",
              marginBottom: 16,
              position: "relative",
            }}
          >
            <Shield style={{ width: 26, height: 26, color: "#000000" }} />
            <span
              style={{
                position: "absolute",
                bottom: -2,
                right: -2,
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "var(--status-online)",
                border: "2px solid var(--bg-base)",
                boxShadow: "0 0 8px var(--status-online)",
              }}
            />
          </div>

          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "-0.02em",
            }}
          >
            ScriptRunner
          </h1>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              marginTop: 4,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            Enterprise Orchestration &amp; RMM
          </p>

          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              padding: "4px 10px",
              borderRadius: 9999,
              background: "rgba(56, 189, 248, 0.08)",
              border: "1px solid rgba(56, 189, 248, 0.2)",
              fontSize: 11,
              color: "var(--accent-primary)",
              fontWeight: 500,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent-primary)",
                boxShadow: "0 0 6px var(--accent-primary)",
              }}
            />
            Restricted Administrator Perimeter
          </div>
        </div>

        {/* Card */}
        <div
          className="card"
          style={{
            padding: "28px 30px",
            background: "rgba(18, 20, 26, 0.85)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04)",
            borderRadius: 16,
          }}
        >
          <div style={{ marginBottom: 20 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--text-primary)",
                letterSpacing: "-0.01em",
              }}
            >
              Sign In to Your Workspace
            </h2>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Authenticate with your corporate credentials to manage nodes and run scripts.
            </p>
          </div>

          {/* Quick-Fill Pill / Demo helper */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px dashed rgba(255, 255, 255, 0.12)",
              marginBottom: 20,
              fontSize: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <KeyRound style={{ width: 13, height: 13, color: "var(--accent-primary)" }} />
                <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: 11 }}>
                  Admin Account
                </span>
              </div>
              <p
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  marginTop: 2,
                  fontFamily: "monospace",
                }}
              >
                admin@scriptrunner.internal
              </p>
            </div>
            <button
              type="button"
              id="quick-fill-btn"
              onClick={handleQuickFill}
              className="btn btn-secondary btn-xs"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                padding: "4px 10px",
                flexShrink: 0,
              }}
            >
              {filledFeedback ? (
                <>
                  <CheckCircle2 style={{ width: 12, height: 12, color: "var(--status-online)" }} />
                  <span style={{ color: "var(--status-online)" }}>Filled</span>
                </>
              ) : (
                <>
                  <Sparkles style={{ width: 12, height: 12 }} />
                  <span>Auto-fill</span>
                </>
              )}
            </button>
          </div>

          {/* Error Alert */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -8, height: 0 }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid rgba(248, 113, 113, 0.25)",
                  background: "rgba(248, 113, 113, 0.08)",
                  color: "var(--status-error)",
                  fontSize: 12,
                  marginBottom: 18,
                  overflow: "hidden",
                }}
              >
                <AlertCircle style={{ width: 15, height: 15, flexShrink: 0 }} />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <form
            onSubmit={handleSubmit(onSubmit)}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
            noValidate
          >
            {/* Email Field */}
            <div>
              <label
                htmlFor="email"
                className="label"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Mail style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                Corporate Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className="input"
                placeholder="admin@scriptrunner.internal"
                {...register("email")}
                aria-invalid={!!errors.email}
                style={{ height: 40 }}
              />
              {errors.email && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                  {errors.email.message}
                </p>
              )}
            </div>

            {/* Password Field */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <label
                  htmlFor="password"
                  className="label"
                  style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}
                >
                  <Lock style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                  Master Password
                </label>
              </div>
              <div style={{ position: "relative" }}>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className="input"
                  placeholder="••••••••••••"
                  {...register("password")}
                  aria-invalid={!!errors.password}
                  style={{ height: 40, paddingRight: 40 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    color: "var(--text-tertiary)",
                    cursor: "pointer",
                    padding: 4,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {showPassword ? (
                    <EyeOff style={{ width: 15, height: 15 }} />
                  ) : (
                    <Eye style={{ width: 15, height: 15 }} />
                  )}
                </button>
              </div>
              {errors.password && (
                <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                  {errors.password.message}
                </p>
              )}
            </div>

            {/* Remember Me */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "2px 0",
              }}
            >
              <label
                htmlFor="rememberMe"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  id="rememberMe"
                  type="checkbox"
                  {...register("rememberMe")}
                  style={{
                    accentColor: "var(--accent-primary)",
                    cursor: "pointer",
                    width: 14,
                    height: 14,
                  }}
                />
                Remember this workstation
              </label>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              id="sign-in-btn"
              className="btn btn-primary"
              disabled={isSubmitting}
              style={{
                width: "100%",
                height: 42,
                marginTop: 4,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" />
                  Authenticating Session…
                </>
              ) : (
                "Authenticate Session"
              )}
            </button>
          </form>
        </div>

        {/* Security Compliance Footer */}
        <p
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "var(--text-tertiary)",
            marginTop: 20,
            lineHeight: 1.5,
          }}
        >
          Protected by hardware-verified cryptographic mutual authentication.
          <br />
          All actions, IP addresses, and console jobs are immutably signed and audited.
        </p>
      </motion.div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-base)",
          }}
        >
          <Loader2 style={{ width: 24, height: 24, color: "var(--accent-primary)" }} className="animate-spin" />
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
