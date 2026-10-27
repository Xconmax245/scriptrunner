import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Cookie-based client (uses anon key + user session).
 * Used for auth checks only.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const url = rawUrl && rawUrl.startsWith("http") ? rawUrl : "http://127.0.0.1:54321";
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key_for_prerender";

  return createServerClient<any>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component — cookies can only be set in Server Actions or Route Handlers
        }
      },
    },
  });
}

/**
 * Service-role admin client for server-side data queries.
 * Bypasses RLS — only use in trusted server contexts.
 * Safe to call from Server Components and Route Handlers.
 */
export function createServiceClient() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const url = rawUrl && rawUrl.startsWith("http") ? rawUrl : "http://127.0.0.1:54321";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key_for_prerender";

  try {
    return createSupabaseClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    console.warn("createServiceClient fallback:", err);
    return createSupabaseClient(
      "http://127.0.0.1:54321",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key_for_prerender",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
}

