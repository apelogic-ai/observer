import type { NextConfig } from "next";

// Static export: produces `.next/out/` with pure HTML/JS/CSS so the dashboard
// can be served by any static host (including the Bun API that handles /api/*
// on the same origin in the shipped binary).
//
// `rewrites` is ignored by `output: 'export'` but still applies under
// `next dev`, so the dev loop continues to proxy /api/* to localhost:3457.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://localhost:3457/api/:path*" },
    ];
  },
};

export default nextConfig;
