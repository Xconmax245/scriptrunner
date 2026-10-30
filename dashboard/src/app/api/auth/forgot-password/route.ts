import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimiter } from "@/lib/auth/rate-limiter";
import { clientIp } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

const forgotSchema = z.object({
  email: z.string().email("Enter a valid corporate email address").max(255),
});

const MAX_FORGOT_ATTEMPTS = 5;
const FORGOT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req) || "127.0.0.1";
    const body = forgotSchema.safeParse(await req.json().catch(() => null));

    if (!body.success) {
      return NextResponse.json(
        { error: "Provide a valid corporate email address." },
        { status: 400 }
      );
    }

    const email = body.data.email.toLowerCase().trim();
    const ipKey = `forgot:ip:${ip}`;

    const ipCheck = authRateLimiter.check(ipKey, MAX_FORGOT_ATTEMPTS, FORGOT_WINDOW_MS);
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "Too many reset requests. Please check your inbox or wait before requesting again." },
        { status: 429 }
      );
    }

    authRateLimiter.recordFailure(ipKey, MAX_FORGOT_ATTEMPTS, FORGOT_WINDOW_MS);

    // Trigger Supabase Auth password reset email
    try {
      const supabase = await createClient();
      const origin = req.nextUrl.origin;
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/reset-password`,
      });
    } catch (err) {
      console.warn("Supabase resetPasswordForEmail warning:", err);
    }

    // Always respond with a generic message to prevent account enumeration
    return NextResponse.json({
      success: true,
      message:
        "If an authorized corporate account is associated with this email address, recovery instructions have been dispatched.",
    });
  } catch (err) {
    console.error("Forgot password route error:", err);
    return NextResponse.json(
      { error: "Internal service error. Please retry." },
      { status: 500 }
    );
  }
}
