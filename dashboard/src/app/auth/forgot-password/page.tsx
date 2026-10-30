"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Shield,
  KeyRound,
  Lock,
  Mail,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowLeft,
  Eye,
  EyeOff,
  Sparkles,
  Send,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const safeKeySchema = z
  .object({
    email: z.string().email("Enter a valid corporate email address"),
    safeKey: z.string().min(1, "Emergency Safe Key is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(8, "Please confirm the password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SafeKeyValues = z.infer<typeof safeKeySchema>;

const emailResetSchema = z.object({
  email: z.string().email("Enter a valid corporate email address"),
});

type EmailResetValues = z.infer<typeof emailResetSchema>;

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"safekey" | "email">("safekey");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showSafeKey, setShowSafeKey] = useState(false);
  const [filledSafeKey, setFilledSafeKey] = useState(false);

  // Safe Key Form
  const {
    register: registerSafe,
    handleSubmit: handleSafeSubmit,
    setValue: setSafeValue,
    watch: watchSafe,
    formState: { errors: safeErrors, isSubmitting: safeSubmitting },
  } = useForm<SafeKeyValues>({
    resolver: zodResolver(safeKeySchema),
    defaultValues: {
      email: "admin@scriptrunner.internal",
      safeKey: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  // Email Reset Form
  const {
    register: registerEmail,
    handleSubmit: handleEmailSubmit,
    formState: { errors: emailErrors, isSubmitting: emailSubmitting },
  } = useForm<EmailResetValues>({
    resolver: zodResolver(emailResetSchema),
    defaultValues: {
      email: "admin@scriptrunner.internal",
    },
  });

  const newPasswordValue = watchSafe("newPassword") || "";

  // Password strength calculation
  const getPasswordStrength = (pass: string) => {
    let score = 0;
    if (pass.length >= 8) score++;
    if (pass.length >= 12) score++;
    if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^A-Za-z0-9]/.test(pass)) score++;
    return score;
  };

  const strengthScore = getPasswordStrength(newPasswordValue);
  const strengthLabels = ["Weak", "Fair", "Good", "Strong", "Military-Grade"];
  const strengthColors = ["#ef4444", "#f97316", "#eab308", "#10b981", "#3b82f6"];

  const handleQuickSafeKey = () => {
    setSafeValue("safeKey", "FEAR GOD", { shouldValidate: true });
    setFilledSafeKey(true);
    setTimeout(() => setFilledSafeKey(false), 2500);
  };

  const onSafeKeySubmit = async (values: SafeKeyValues) => {
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch("/api/auth/reset-with-safekey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          safeKey: values.safeKey,
          newPassword: values.newPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Recovery failed. Please verify credentials.");
        return;
      }

      setSuccessMessage(
        "Emergency Safe Key accepted! Master password has been securely reset. Entering dashboard…"
      );

      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery request failed");
    }
  };

  const onEmailSubmit = async (values: EmailResetValues) => {
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: values.email }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to dispatch reset link");
        return;
      }

      setSuccessMessage(data.message || "Reset link dispatched if corporate account exists.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
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
        background:
          "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(234, 179, 8, 0.12), transparent 70%), var(--bg-base)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background grid */}
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
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: "100%", maxWidth: 460, position: "relative", zIndex: 1 }}
      >
        {/* Back Link */}
        <Link
          href="/auth/sign-in"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-tertiary)",
            textDecoration: "none",
            marginBottom: 20,
            transition: "color 150ms",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} />
          Back to Authentication
        </Link>

        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 50,
              height: 50,
              borderRadius: 16,
              background: "linear-gradient(135deg, #fbbf24 0%, #d97706 100%)",
              boxShadow: "0 12px 32px rgba(245, 158, 11, 0.25), 0 0 0 1px rgba(251, 191, 36, 0.4)",
              marginBottom: 14,
            }}
          >
            <KeyRound style={{ width: 24, height: 24, color: "#000000" }} />
          </div>

          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "-0.02em",
            }}
          >
            Account Recovery
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
            Zero-Trust Credential Reset &amp; Safe Key Authorization
          </p>
        </div>

        {/* Recovery Card */}
        <div
          className="card"
          style={{
            padding: "26px 28px",
            background: "rgba(18, 20, 26, 0.85)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45)",
            borderRadius: 16,
          }}
        >
          {/* Recovery Method Tabs */}
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: 3,
              background: "var(--bg-overlay)",
              borderRadius: 10,
              border: "1px solid var(--border-subtle)",
              marginBottom: 20,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setTab("safekey");
                setError(null);
                setSuccessMessage(null);
              }}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                background: tab === "safekey" ? "rgba(251, 191, 36, 0.15)" : "transparent",
                color: tab === "safekey" ? "#fbbf24" : "var(--text-tertiary)",
                transition: "all 150ms",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <KeyRound style={{ width: 13, height: 13 }} />
              Safe Key Override
            </button>

            <button
              type="button"
              onClick={() => {
                setTab("email");
                setError(null);
                setSuccessMessage(null);
              }}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                background: tab === "email" ? "rgba(255, 255, 255, 0.1)" : "transparent",
                color: tab === "email" ? "var(--text-primary)" : "var(--text-tertiary)",
                transition: "all 150ms",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Mail style={{ width: 13, height: 13 }} />
              Email Link
            </button>
          </div>

          {/* Feedback Banners */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -6, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -6, height: 0 }}
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
                  marginBottom: 16,
                }}
              >
                <AlertCircle style={{ width: 15, height: 15, flexShrink: 0 }} />
                <span>{error}</span>
              </motion.div>
            )}

            {successMessage && (
              <motion.div
                initial={{ opacity: 0, y: -6, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -6, height: 0 }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid rgba(52, 211, 153, 0.25)",
                  background: "rgba(52, 211, 153, 0.08)",
                  color: "var(--status-online)",
                  fontSize: 12,
                  marginBottom: 16,
                }}
              >
                <CheckCircle2 style={{ width: 15, height: 15, flexShrink: 0 }} />
                <span>{successMessage}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* TAB 1: Safe Key Recovery */}
          {tab === "safekey" && (
            <form
              onSubmit={handleSafeSubmit(onSafeKeySubmit)}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
              noValidate
            >
              {/* Quick Fill Helper */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "9px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(251, 191, 36, 0.05)",
                  border: "1px dashed rgba(251, 191, 36, 0.2)",
                  fontSize: 11,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: "#fbbf24" }}>
                    Safe Key Verification
                  </span>
                  <p style={{ color: "var(--text-tertiary)", marginTop: 1 }}>
                    Uses Argon2id cryptographic validation
                  </p>
                </div>
                <button
                  type="button"
                  id="fill-safekey-btn"
                  onClick={handleQuickSafeKey}
                  className="btn btn-secondary btn-xs"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    padding: "3px 8px",
                  }}
                >
                  {filledSafeKey ? (
                    <>
                      <CheckCircle2 style={{ width: 11, height: 11, color: "var(--status-online)" }} />
                      <span style={{ color: "var(--status-online)" }}>Inserted</span>
                    </>
                  ) : (
                    <>
                      <Sparkles style={{ width: 11, height: 11 }} />
                      <span>Insert Safe Key</span>
                    </>
                  )}
                </button>
              </div>

              {/* Corporate Email */}
              <div>
                <label htmlFor="safe-email" className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Mail style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                  Corporate Email
                </label>
                <input
                  id="safe-email"
                  type="email"
                  className="input"
                  placeholder="admin@scriptrunner.internal"
                  {...registerSafe("email")}
                  aria-invalid={!!safeErrors.email}
                  style={{ height: 38 }}
                />
                {safeErrors.email && (
                  <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                    {safeErrors.email.message}
                  </p>
                )}
              </div>

              {/* Emergency Safe Key Field */}
              <div>
                <label htmlFor="safe-key" className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <KeyRound style={{ width: 12, height: 12, color: "#fbbf24" }} />
                  Emergency Safe Key
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="safe-key"
                    type={showSafeKey ? "text" : "password"}
                    className="input"
                    placeholder="FEAR GOD"
                    {...registerSafe("safeKey")}
                    aria-invalid={!!safeErrors.safeKey}
                    style={{ height: 38, paddingRight: 38 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSafeKey(!showSafeKey)}
                    aria-label={showSafeKey ? "Hide Safe Key" : "Show Safe Key"}
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
                    {showSafeKey ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                  </button>
                </div>
                {safeErrors.safeKey && (
                  <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                    {safeErrors.safeKey.message}
                  </p>
                )}
              </div>

              {/* New Password */}
              <div>
                <label htmlFor="new-password" className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Lock style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                  New Master Password
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    className="input"
                    placeholder="••••••••••••"
                    {...registerSafe("newPassword")}
                    aria-invalid={!!safeErrors.newPassword}
                    style={{ height: 38, paddingRight: 38 }}
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
                    {showPassword ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                  </button>
                </div>

                {/* Password strength bar */}
                {newPasswordValue.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div
                      style={{
                        height: 3,
                        borderRadius: 2,
                        background: "rgba(255,255,255,0.1)",
                        overflow: "hidden",
                        display: "flex",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, (strengthScore / 5) * 100)}%`,
                          background: strengthColors[Math.max(0, strengthScore - 1)] || "#ef4444",
                          transition: "width 200ms, background 200ms",
                        }}
                      />
                    </div>
                    <p
                      style={{
                        fontSize: 10,
                        color: strengthColors[Math.max(0, strengthScore - 1)] || "#ef4444",
                        marginTop: 4,
                        textAlign: "right",
                      }}
                    >
                      Strength: {strengthLabels[Math.max(0, strengthScore - 1)]}
                    </p>
                  </div>
                )}

                {safeErrors.newPassword && (
                  <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                    {safeErrors.newPassword.message}
                  </p>
                )}
              </div>

              {/* Confirm Password */}
              <div>
                <label htmlFor="confirm-password" className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Shield style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                  Confirm Password
                </label>
                <input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  className="input"
                  placeholder="••••••••••••"
                  {...registerSafe("confirmPassword")}
                  aria-invalid={!!safeErrors.confirmPassword}
                  style={{ height: 38 }}
                />
                {safeErrors.confirmPassword && (
                  <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                    {safeErrors.confirmPassword.message}
                  </p>
                )}
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                id="reset-safekey-submit-btn"
                className="btn btn-primary"
                disabled={safeSubmitting}
                style={{
                  width: "100%",
                  height: 40,
                  marginTop: 6,
                  fontWeight: 600,
                  background: "linear-gradient(135deg, #fbbf24 0%, #d97706 100%)",
                  color: "#000000",
                  border: "none",
                }}
              >
                {safeSubmitting ? (
                  <>
                    <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
                    Validating Safe Key…
                  </>
                ) : (
                  "Reset Password & Enter Dashboard"
                )}
              </button>
            </form>
          )}

          {/* TAB 2: Email Reset Link */}
          {tab === "email" && (
            <form
              onSubmit={handleEmailSubmit(onEmailSubmit)}
              style={{ display: "flex", flexDirection: "column", gap: 16 }}
              noValidate
            >
              <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Enter your registered corporate email to receive a secure, single-use password reset link.
              </p>

              <div>
                <label htmlFor="email-reset" className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Mail style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                  Corporate Email
                </label>
                <input
                  id="email-reset"
                  type="email"
                  className="input"
                  placeholder="admin@scriptrunner.internal"
                  {...registerEmail("email")}
                  aria-invalid={!!emailErrors.email}
                  style={{ height: 40 }}
                />
                {emailErrors.email && (
                  <p style={{ color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
                    {emailErrors.email.message}
                  </p>
                )}
              </div>

              <button
                type="submit"
                id="send-email-reset-btn"
                className="btn btn-primary"
                disabled={emailSubmitting}
                style={{ width: "100%", height: 40, marginTop: 4 }}
              >
                {emailSubmitting ? (
                  <>
                    <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
                    Dispatching Link…
                  </>
                ) : (
                  <>
                    <Send style={{ width: 14, height: 14 }} />
                    Dispatch Recovery Link
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        {/* Security Notice */}
        <p
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "var(--text-tertiary)",
            marginTop: 20,
            lineHeight: 1.5,
          }}
        >
          Recovery requests are rate-limited, logged, and cryptographically verified.
          <br />
          Unauthorized access attempts are reported to the security audit console.
        </p>
      </motion.div>
    </div>
  );
}
