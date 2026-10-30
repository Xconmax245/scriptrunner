"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Loader2, Eye, EyeOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const signInSchema = z.object({
  email: z.string().email("Enter a valid email address"),
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
  const supabase = createClient();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
      rememberMe: true,
    },
  });

  const onSubmit = async (values: SignInValues) => {
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email.trim(),
          password: values.password,
        }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok) {
        setError(result?.error || "Incorrect email or password.");
        return;
      }

      try {
        await supabase.auth.signInWithPassword({
          email: values.email.trim(),
          password: values.password,
        });
      } catch {
        // Session sync handled via HttpOnly SSR cookie
      }

      const destination = returnUrl.startsWith("/dashboard") ? returnUrl : "/dashboard";
      router.push(destination);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reach the authentication service.");
    }
  };

  return (
    <div style={pageStyle}>
      {/* Subtle noise texture overlay */}
      <div style={noiseStyle} />

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: "100%", maxWidth: 380, position: "relative", zIndex: 1 }}
      >
        {/* Wordmark */}
        <div style={{ marginBottom: 40 }}>
          <div style={logoRowStyle}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="20" height="20" rx="5" stroke="white" strokeWidth="1.5" />
              <path d="M7 8h8M7 11h5M7 14h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span style={wordmarkStyle}>ScriptRunner</span>
          </div>
          <h1 style={headingStyle}>Sign in</h1>
          <p style={subheadingStyle}>Enter your credentials to access the dashboard.</p>
        </div>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: "auto", marginBottom: 20 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              style={errorBannerStyle}
            >
              <AlertCircle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handleSubmit(onSubmit)} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Email */}
          <div>
            <label htmlFor="email" style={labelStyle}>Email</label>
            <input
              id="email"
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

          {/* Password */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <label htmlFor="password" style={{ ...labelStyle, marginBottom: 0 }}>Password</label>
              <Link
                href="/auth/forgot-password"
                id="forgot-password-link"
                style={forgotLinkStyle}
                onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.75)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.38)")}
              >
                Forgot password?
              </Link>
            </div>
            <div style={{ position: "relative" }}>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                {...register("password")}
                aria-invalid={!!errors.password}
                style={{ ...inputStyle(!!errors.password), paddingRight: 42 }}
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
            {errors.password && <p style={fieldErrorStyle}>{errors.password.message}</p>}
          </div>

          {/* Remember me */}
          <label style={checkboxLabelStyle}>
            <input
              id="rememberMe"
              type="checkbox"
              {...register("rememberMe")}
              style={{ accentColor: "#fff", width: 14, height: 14, cursor: "pointer" }}
            />
            Keep me signed in
          </label>

          {/* Submit */}
          <button
            type="submit"
            id="sign-in-btn"
            disabled={isSubmitting}
            style={submitButtonStyle(isSubmitting)}
          >
            {isSubmitting ? (
              <>
                <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

/* ─── Style constants ─── */

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

const logoRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  marginBottom: 28,
};

const wordmarkStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "rgba(255,255,255,0.9)",
  letterSpacing: "-0.02em",
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
  lineHeight: 1.5,
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

const forgotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.38)",
  textDecoration: "none",
  transition: "color 150ms",
  letterSpacing: "-0.005em",
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

const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "rgba(255,255,255,0.45)",
  cursor: "pointer",
  userSelect: "none",
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

/* ─── Page export ─── */

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
            background: "#0a0a0a",
          }}
        >
          <Loader2 style={{ width: 20, height: 20, color: "rgba(255,255,255,0.3)" }} className="animate-spin" />
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
