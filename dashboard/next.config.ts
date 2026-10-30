import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://uhbadfopfolwwooqzzbb.supabase.co";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/rest/v1/:path*",
        destination: `${supabaseUrl}/rest/v1/:path*`,
      },
      {
        source: "/auth/v1/:path*",
        destination: `${supabaseUrl}/auth/v1/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
