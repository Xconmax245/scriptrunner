"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  ArrowLeft,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

/* ─── Schema ─── */

const safeKeySchema = z
  .object({
    email: z.string().email("Enter a valid email address"),
    safeKey: z.string().min(1, "Safe key is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(8, "Please confirm the password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SafeKeyValues = z.infer<typeof safeKeySchema>;

/* ─── Component ─── */

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showSafeKey, setShowSafeKey] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SafeKeyValues>({
    resolver: zodResolver(safeKeySchema),
    defaultValues: { email: "", safeKey: "", newPassword: "", confirmPassword: "" },
  });

  const newPasswordValue = watch("newPassword") || "";

  /* Password strength */
  const getStrength = (pass: string) => {
    let s = 0;
    if (pass.length >= 8) s++;
    if (pass.length >= 12) s++;
    if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) s++;
    if (/[0-9]/.test(pass)) s++;
    if (/[^A-Za-z0-9]/.test(pass)) s++;
    return s;
  };

  const strength = getStrength(newPasswordValue);
  const strengthColor = ["#ef4444", "#f97316", "#eab308", "#10b981", "#3b82f6"][
    Math.max(0, strength - 1)
  ] || "#ef4444";
  const strengthLabel = ["Weak", "Fair", "Good", "Strong", "Excellent"][
    Math.max(0, strength - 1)
  ] || "Weak";

  const onSubmit = async (values: SafeKeyValues) => {
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
        setError(data.error || "Recovery failed. Please check your credentials.");
        return;
      }
      setSuccessMessage("Password reset. Signing you in…");
      setTimeout(() => { router.push("/dashboard"); router.refresh(); }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  };

  return (
    <div style={pageStyle}>
      <div style={noiseStyle} />

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: "100%", maxWidth: 380, position: "relative", zIndex: 1 }}
      >
        {/* Back link */}
        <Link
          href="/auth/sign-in"
          style={backLinkStyle}
          onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.65)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
        >
          <ArrowLeft style={{ width: 13, height: 13 }} />
          Back to sign in
        </Link>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={headingStyle}>Account recovery</h1>
          <p style={subheadingStyle}>
            Enter your safe key to reset your password and sign in.
          </p>
        </div>

        {/* Banners */}
        <AnimatePresence>
          {error && (
            <motion.div
              key="err"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: "auto", marginBottom: 20 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              style={errorBannerStyle}
            >
              <AlertCircle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </motion.div>
          )}
          {successMessage && (
            <motion.div
              key="ok"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: "auto", marginBottom: 20 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              style={successBannerStyle}
            >
              <CheckCircle2 style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
              <span>{successMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: 18 }}
        >
          {/* Email */}
          <div>
            <label htmlFor="safe-email" style={labelStyle}>Email</label>
            <input
              id="safe-email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              {...register("email")}
              aria-invalid={!!errors.email}
              style={inputStyle(!!errors.email)}
            />
            {errors.email && <p style={fieldErrorStyle}>{errors.email.message}</p>}
          </div>

          {/* Safe Key */}
          <div>
            <label htmlFor="safe-key" style={labelStyle}>Safe Key</label>
            <div style={{ position: "relative" }}>
              <input
                id="safe-key"
                type={showSafeKey ? "text" : "password"}
                autoComplete="off"
                placeholder="Enter your safe key"
                {...register("safeKey")}
                aria-invalid={!!errors.safeKey}
                style={{ ...inputStyle(!!errors.safeKey), paddingRight: 42 }}
              />
              <button
                type="button"
                onClick={() => setShowSafeKey(!showSafeKey)}
                aria-label={showSafeKey ? "Hide safe key" : "Show safe key"}
                style={eyeButtonStyle}
              >
                {showSafeKey
                  ? <EyeOff style={{ width: 15, height: 15 }} />
                  : <Eye style={{ width: 15, height: 15 }} />}
              </button>
            </div>
            {errors.safeKey && <p style={fieldErrorStyle}>{errors.safeKey.message}</p>}
          </div>

          {/* New Password */}
          <div>
            <label htmlFor="new-password" style={labelStyle}>New Password</label>
            <div style={{ position: "relative" }}>
              <input
                id="new-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="••••••••"
                {...register("newPassword")}
                aria-invalid={!!errors.newPassword}
                style={{ ...inputStyle(!!errors.newPassword), paddingRight: 42 }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                style={eyeButtonStyle}
              >
                {showPassword
                  ? <EyeOff style={{ width: 15, height: 15 }} />
                  : <Eye style={{ width: 15, height: 15 }} />}
              </button>
            </div>
            {newPasswordValue.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ height: 2, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, (strength / 5) * 100)}%`,
                      background: strengthColor,
                      transition: "width 200ms, background 200ms",
                      borderRadius: 2,
                    }}
                  />
                </div>
                <p style={{ fontSize: 11, color: strengthColor, marginTop: 4, textAlign: "right" }}>
                  {strengthLabel}
                </p>
              </div>
            )}
            {errors.newPassword && <p style={fieldErrorStyle}>{errors.newPassword.message}</p>}
          </div>

          {/* Confirm Password */}
          <div>
            <label htmlFor="confirm-password" style={labelStyle}>Confirm Password</label>
            <input
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="••••••••"
              {...register("confirmPassword")}
              aria-invalid={!!errors.confirmPassword}
              style={inputStyle(!!errors.confirmPassword)}
            />
            {errors.confirmPassword && <p style={fieldErrorStyle}>{errors.confirmPassword.message}</p>}
          </div>

          <button
            type="submit"
            id="reset-safekey-submit-btn"
            disabled={isSubmitting}
            style={submitButtonStyle(isSubmitting)}
          >
            {isSubmitting ? (
              <>
                <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" />
                Verifying…
              </>
            ) : (
              "Reset & Sign In"
            )}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

/* ─── Styles ─── */

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 24px",
  background: "#0a0a0a",
  position: "relative",
  overflow: "hidden",
};

const noiseStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E")`,
  backgroundRepeat: "repeat",
  backgroundSize: "128px 128px",
  pointerEvents: "none",
  opacity: 0.6,
};

const backLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 13,
  color: "rgba(255,255,255,0.3)",
  textDecoration: "none",
  marginBottom: 28,
  transition: "color 150ms",
};

const headingStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#ffffff",
  letterSpacing: "-0.03em",
  lineHeight: 1.1,
  marginBottom: 8,
};

const subheadingStyle: React.CSSProperties = {
  fontSize: 14,
  color: "rgba(255,255,255,0.42)",
  lineHeight: 1.55,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 500,
  color: "rgba(255,255,255,0.65)",
  marginBottom: 6,
  letterSpacing: "-0.005em",
};

const inputStyle = (hasError: boolean): React.CSSProperties => ({
  width: "100%",
  height: 42,
  padding: "0 12px",
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${hasError ? "rgba(248,113,113,0.6)" : "rgba(255,255,255,0.1)"}`,
  borderRadius: 8,
  color: "#ffffff",
  fontSize: 14,
  outline: "none",
  transition: "border-color 150ms",
  fontFamily: "inherit",
});

const fieldErrorStyle: React.CSSProperties = {
  color: "#f87171",
  fontSize: 12,
  marginTop: 5,
};

const eyeButtonStyle: React.CSSProperties = {
  position: "absolute",
  right: 11,
  top: "50%",
  transform: "translateY(-50%)",
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.35)",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
};

const submitButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: "100%",
  height: 42,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  background: disabled ? "rgba(255,255,255,0.08)" : "#ffffff",
  color: disabled ? "rgba(255,255,255,0.35)" : "#000000",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  letterSpacing: "-0.01em",
  transition: "background 150ms, color 150ms",
  fontFamily: "inherit",
  marginTop: 4,
});

const errorBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  padding: "11px 14px",
  borderRadius: 8,
  border: "1px solid rgba(248,113,113,0.2)",
  background: "rgba(248,113,113,0.06)",
  color: "#f87171",
  fontSize: 13,
  lineHeight: 1.4,
  overflow: "hidden",
};

const successBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  padding: "11px 14px",
  borderRadius: 8,
  border: "1px solid rgba(52,211,153,0.2)",
  background: "rgba(52,211,153,0.06)",
  color: "#34d399",
  fontSize: 13,
  lineHeight: 1.4,
  overflow: "hidden",
};
