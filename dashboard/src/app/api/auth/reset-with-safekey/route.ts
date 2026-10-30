import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { authRateLimiter } from "@/lib/auth/rate-limiter";
import { clientIp } from "@/lib/auth/authorization";
import { verifySafeKey } from "@/lib/auth/safekey";

export const dynamic = "force-dynamic";

const resetSchema = z.object({
  email: z.string().email("Enter a valid corporate email address").max(255),
  safeKey: z.string().min(1, "Safe Key is required").max(100),
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(255),
});

const MAX_SAFEKEY_ATTEMPTS = 3;
const SAFEKEY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SAFEKEY_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes lockout

export async function POST(req: NextRequest) {
  try {
    if (process.env.NODE_ENV !== "production" && req.headers.get("x-auth-test-reset") === "1") {
      authRateLimiter.clearAll();
      return NextResponse.json({ success: true, reset: true });
    }
    const ip = clientIp(req) || "127.0.0.1";
    const body = resetSchema.safeParse(await req.json().catch(() => null));

    if (!body.success) {
      const firstIssue = body.error.issues[0]?.message || "Invalid submission payload.";
      return NextResponse.json({ error: firstIssue }, { status: 400 });
    }

    const email = body.data.email.toLowerCase().trim();
    const { safeKey, newPassword } = body.data;

    const ipKey = `safekey:ip:${ip}`;
    const userKey = `safekey:user:${email}`;

    // 1. Cryptographic Argon2id Safe Key Verification
    const isSafeKeyValid = await verifySafeKey(safeKey);

    if (isSafeKeyValid) {
      // Authentic Safe Key: immediately unlock and clear rate limit buckets
      authRateLimiter.reset(ipKey);
      authRateLimiter.reset(userKey);
      authRateLimiter.reset(`login:ip:${ip}`);
      authRateLimiter.reset(`login:user:${email}`);
    } else {
      // Safe Key was incorrect: enforce rate limiting against brute-force guessing
      const ipCheck = authRateLimiter.check(ipKey, MAX_SAFEKEY_ATTEMPTS, SAFEKEY_WINDOW_MS, SAFEKEY_LOCKOUT_MS);
      if (!ipCheck.allowed) {
        const retryAfter = ipCheck.retryAfterSeconds || 60;
        return NextResponse.json(
          {
            error: "Too many failed recovery attempts. Emergency Safe Key verification is locked. Try again later.",
            retryAfter,
          },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfter) },
          }
        );
      }

      authRateLimiter.recordFailure(ipKey, MAX_SAFEKEY_ATTEMPTS, SAFEKEY_WINDOW_MS, SAFEKEY_LOCKOUT_MS);
      authRateLimiter.recordFailure(userKey, MAX_SAFEKEY_ATTEMPTS, SAFEKEY_WINDOW_MS, SAFEKEY_LOCKOUT_MS);

      // Return generic error to prevent brute forcing
      return NextResponse.json(
        { error: "Invalid recovery credentials or Safe Key authorization failed." },
        { status: 401 }
      );
    }

    // 3. Locate user in Supabase Auth via Service Client
    const service = createServiceClient();
    const { data: usersData, error: listError } = await service.auth.admin.listUsers();

    if (listError) {
      console.error("Supabase user query error during safe key reset:", listError);
      return NextResponse.json({ error: "Recovery service unavailable." }, { status: 500 });
    }

    const targetUser = usersData.users.find(
      (u) => u.email?.toLowerCase().trim() === email
    );

    if (!targetUser) {
      authRateLimiter.recordFailure(ipKey, MAX_SAFEKEY_ATTEMPTS, SAFEKEY_WINDOW_MS, SAFEKEY_LOCKOUT_MS);
      authRateLimiter.recordFailure(userKey, MAX_SAFEKEY_ATTEMPTS, SAFEKEY_WINDOW_MS, SAFEKEY_LOCKOUT_MS);

      // Generic error response protects against email enumeration
      return NextResponse.json(
        { error: "Invalid recovery credentials or Safe Key authorization failed." },
        { status: 401 }
      );
    }

    // 4. Update the User's Password securely
    const { error: updateError } = await service.auth.admin.updateUserById(targetUser.id, {
      password: newPassword,
    });

    if (updateError) {
      console.error("Password update error during safe key reset:", updateError);
      return NextResponse.json(
        { error: updateError.message || "Failed to update master password." },
        { status: 500 }
      );
    }

    // 5. Reset all rate limiting counters for this user and IP
    authRateLimiter.reset(ipKey);
    authRateLimiter.reset(userKey);
    authRateLimiter.reset(`login:ip:${ip}`);
    authRateLimiter.reset(`login:user:${email}`);

    // 6. Immutably log audit event
    try {
      await service.from("audit_events").insert({
        event_type: "auth_password_reset_safekey",
        actor_user_id: targetUser.id,
        severity: "warning",
        metadata: {
          ip,
          email,
          auth_method: "argon2id_safekey",
          timestamp: new Date().toISOString(),
        },
      });
    } catch (auditErr) {
      console.warn("Audit logging warning during safe key reset:", auditErr);
    }

    // 7. Establish server session cookies immediately so user enters dashboard smoothly
    try {
      const supabase = await createClient();
      await supabase.auth.signInWithPassword({
        email: targetUser.email || email,
        password: newPassword,
      });
    } catch (sessionErr) {
      console.warn("Session establishment warning:", sessionErr);
    }

    return NextResponse.json({
      success: true,
      message: "Emergency Safe Key verified. Master password updated and session authenticated.",
    });
  } catch (err) {
    console.error("Safe Key recovery route error:", err);
    return NextResponse.json(
      { error: "Internal recovery processing error. Please retry." },
      { status: 500 }
    );
  }
}
