import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/types/database";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key_for_prerender",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data?.user ?? null;
  } catch {
    user = null;
  }

  const { pathname } = request.nextUrl;

  const isDashboardRoute = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isAuthRoute = pathname.startsWith("/auth/");
  const isRootRoute = pathname === "/";
  const isProtectedApiRoute =
    pathname.startsWith("/api/terminal") ||
    pathname.startsWith("/api/devices") ||
    pathname.startsWith("/api/deployments") ||
    pathname.startsWith("/api/enrollment-keys") ||
    pathname.startsWith("/api/enrollment-policy") ||
    pathname.startsWith("/api/jobs");

  // Login Wall Check:
  if (!user) {
    if (isDashboardRoute || isRootRoute) {
      const signInUrl = new URL("/auth/sign-in", request.url);
      if (isDashboardRoute) {
        signInUrl.searchParams.set("returnUrl", pathname + request.nextUrl.search);
      }
      const redirectResponse = NextResponse.redirect(signInUrl);
      supabaseResponse.cookies.getAll().forEach(cookie => {
        redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
      });
      return redirectResponse;
    }

    if (isProtectedApiRoute) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
  } else {
    // Authenticated user attempting to visit auth pages (e.g. /auth/sign-in)
    if (isAuthRoute) {
      const returnUrl = request.nextUrl.searchParams.get("returnUrl");
      const targetPath = returnUrl && returnUrl.startsWith("/dashboard") ? returnUrl : "/dashboard";
      const redirectResponse = NextResponse.redirect(new URL(targetPath, request.url));
      supabaseResponse.cookies.getAll().forEach(cookie => {
        redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
      });
      return redirectResponse;
    }

    if (isRootRoute) {
      const redirectResponse = NextResponse.redirect(new URL("/dashboard", request.url));
      supabaseResponse.cookies.getAll().forEach(cookie => {
        redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
      });
      return redirectResponse;
    }
  }

  return supabaseResponse;
}
