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
};

export default nextConfig;
