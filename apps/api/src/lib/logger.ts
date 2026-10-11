import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.headers['x-goog-api-key']",
      "res.headers['set-cookie']",
      "*.password",
      "*.apiKey",
      "*.secret",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[redacted]",
  },
  transport: isDev ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
});

const SENSITIVE_QUERY = /^(token|code|state|otp|key|api_?key|secret|password|signature|sig|access_token|refresh_token|id_token)$/i;

/**
 * Removes one-time tokens from URLs before they're logged: password-reset links carry the token
 * in the path, email verification and OAuth callbacks carry it in the query string.
 */
export function redactUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const u = new URL(raw, "http://x");
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, "[redacted]");
    const path = u.pathname.replace(/(\/reset-password\/)[^/]+/i, "$1[redacted]");
    return path + (u.search ? decodeURIComponent(u.search) : "");
  } catch {
    return "[unparseable url]";
  }
}

/**
 * Shortens an IP address for logs: the last IPv4 octet / everything after the first 48 bits of
 * IPv6 is zeroed. Enough to spot abuse from a network, not enough to identify a household.
 */
export function truncateIp(ip: string | undefined): string | undefined {
  if (!ip) return ip;
  const v4 = ip.replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.replace(/\.\d+$/, ".0");
  if (ip.includes(":")) {
    const [head] = ip.split("::");
    const groups = (head ?? "").split(":").filter(Boolean).slice(0, 3);
    return `${groups.join(":")}::/48`;
  }
  return "[unknown]";
}

/** Request headers worth logging. Everything else (referer, forwarded-for, cookies, custom headers) is dropped. */
const LOGGED_HEADERS = ["host", "content-type", "content-length", "user-agent", "accept", "x-request-id"] as const;

/** pino-http request serializer: an allow-list, so new or unusual headers never reach the logs. */
export function serializeRequest(r: {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  raw?: { ip?: string };
}) {
  const headers: Record<string, unknown> = {};
  for (const h of LOGGED_HEADERS) {
    const v = r.headers?.[h];
    if (v !== undefined) headers[h] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  // Origin is a site, not a person: keep only scheme + host.
  const origin = r.headers?.origin;
  if (typeof origin === "string") headers.origin = origin.replace(/^(https?:\/\/[^/]+).*$/i, "$1").slice(0, 200);
  return { id: r.id, method: r.method, url: redactUrl(r.url), headers, ip: truncateIp(r.raw?.ip ?? r.remoteAddress) };
}

/** pino-http response serializer: status only (response headers can carry cookies). */
export function serializeResponse(r: { statusCode?: number }) {
  return { statusCode: r.statusCode };
}

/**
 * Compact error for logs. Provider SDK errors carry the full request (customer prompts,
 * headers), so only the essentials are kept.
 */
export function errSummary(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & { code?: unknown; statusCode?: unknown; cause?: unknown };
  return {
    name: e.name,
    message: e.message.slice(0, 1000),
    code: e.code,
    statusCode: e.statusCode,
    stack: e.stack?.split("\n").slice(0, 8).join("\n"),
    cause: e.cause instanceof Error ? { name: e.cause.name, message: e.cause.message.slice(0, 500) } : undefined,
  };
}
