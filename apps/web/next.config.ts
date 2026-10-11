import type { NextConfig } from "next";
import { commonSecurityHeaders, contentSecurityPolicy } from "./src/lib/security-headers";

const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // Don't advertise the framework (X-Powered-By: Next.js).
  poweredByHeader: false,
  // Docker builds set NEXT_OUTPUT=standalone for a minimal production server.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // The browser only talks to this origin. Locally, /api/* is proxied to the Express API;
  // in AWS the ALB routes /api/* to the API service before requests reach Next.js.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  async redirects() {
    return [{ source: "/settings", destination: "/settings/members", permanent: false }];
  },
  async headers() {
    return [
      // Everything except widget embeds must never be framed (clickjacking).
      { source: "/((?!embed/).*)", headers: [...commonSecurityHeaders, { key: "Content-Security-Policy", value: contentSecurityPolicy("'none'") }] },
      // Embeds get their CSP from proxy.ts (frame-ancestors = the deployment's allowed websites).
      { source: "/embed/:path*", headers: commonSecurityHeaders },
      // The widget loader is loaded cross-origin by customer websites.
      { source: "/widget.js", headers: [{ key: "Cache-Control", value: "public, max-age=300" }, { key: "Access-Control-Allow-Origin", value: "*" }] },
    ];
  },
};

export default nextConfig;
