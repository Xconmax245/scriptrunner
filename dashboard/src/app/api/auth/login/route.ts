import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimiter } from "@/lib/auth/rate-limiter";
import { clientIp } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
});

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export async function POST(req: NextRequest) {
  try {
    if (process.env.NODE_ENV !== "production" && req.headers.get("x-auth-test-reset") === "1") {
      authRateLimiter.clearAll();
      return NextResponse.json({ success: true, reset: true });
    }
    const ip = clientIp(req) || "127.0.0.1";
    const body = loginSchema.safeParse(await req.json().catch(() => null));

    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid corporate credentials. Check email and master password." },
        { status: 400 }
      );
    }

    const email = body.data.email.toLowerCase().trim();
    const ipKey = `login:ip:${ip}`;
    const userKey = `login:user:${email}`;

    // 1. Check Rate Limiter
    const ipCheck = authRateLimiter.check(ipKey, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
    const userCheck = authRateLimiter.check(userKey, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);

    if (!ipCheck.allowed || !userCheck.allowed) {
      const retryAfter = Math.max(ipCheck.retryAfterSeconds || 0, userCheck.retryAfterSeconds || 0, 60);
      return NextResponse.json(
        {
          error: "Too many failed authentication attempts. Account access is temporarily locked. Please try again later or use the Emergency Safe Key recovery.",
          retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
          },
        }
      );
    }

    // 2. Perform Server-Side Supabase Authentication with HttpOnly cookie persistence
    const supabase = await createClient();
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password: body.data.password,
    });

    if (authError || !data.session) {
      // Record failed attempt in rate limiter
      authRateLimiter.recordFailure(ipKey, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
      authRateLimiter.recordFailure(userKey, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);

      // Return generic error (prevents user/email enumeration)
      return NextResponse.json(
        { error: "Invalid corporate credentials. Check email and master password." },
        { status: 401 }
      );
    }

    // 3. Clear rate limit on successful authentication
    authRateLimiter.reset(ipKey);
    authRateLimiter.reset(userKey);

    return NextResponse.json({
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err) {
    console.error("Login route error:", err);
    return NextResponse.json(
      { error: "Internal authentication error. Please retry." },
      { status: 500 }
    );
  }
}
