import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/security-headers";

/**
 * Widget embed pages may only be framed by the websites the customer allowed for that
 * deployment. The browser enforces this via CSP `frame-ancestors`, which can't be faked
 * by a third-party site (unlike checking the referrer in JavaScript).
 */
const API_URL = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

export async function proxy(request: NextRequest) {
  const publicKey = request.nextUrl.pathname.split("/")[2] ?? "";
  let ancestors = "'none'";
  if (/^pk_[A-Za-z0-9_-]{10,64}$/.test(publicKey)) {
    try {
      const res = await fetch(`${API_URL}/api/public/v1/deployments/${publicKey}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const cfg = (await res.json()) as { channel: string; allowedOrigins: string[] };
        const origins = cfg.channel === "web_widget" ? cfg.allowedOrigins.filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) : [];
        if (origins.length) ancestors = origins.join(" ");
      }
    } catch {
      // Fail closed: no framing allowed.
    }
  }
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(ancestors));
  return response;
}

export const config = {
  matcher: "/embed/:publicKey*",
};
