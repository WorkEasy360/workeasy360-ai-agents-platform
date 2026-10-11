/**
 * Security headers shared by next.config.ts (all pages) and proxy.ts (widget embeds, whose
 * frame-ancestors depend on the deployment). Next.js App Router injects inline scripts, so
 * script-src needs 'unsafe-inline'; everything else is limited to our own origin.
 */
const isProd = process.env.NODE_ENV === "production";

export function contentSecurityPolicy(frameAncestors: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export const commonSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Browsers only honour HSTS over HTTPS; production is HTTPS-only (APP_URL is checked at API startup).
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];
