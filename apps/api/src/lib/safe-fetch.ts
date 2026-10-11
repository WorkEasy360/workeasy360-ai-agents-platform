import dns from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound HTTP for user-configured URLs (API tools, URL import). Blocks SSRF:
 * - only http/https, ports 80/443 (any port when ALLOW_PRIVATE_EGRESS in dev)
 * - every resolved IP is checked *at connect time* by a custom DNS lookup,
 *   so DNS rebinding between "check" and "connect" can't reach private ranges
 * - redirects are followed manually (max 3) and each hop is re-validated
 * - response size and total time are capped
 */

export class EgressBlockedError extends Error {}

const BLOCKED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
]);

const allowPrivate = () => process.env.ALLOW_PRIVATE_EGRESS === "true" && process.env.NODE_ENV !== "production";

export function isPublicAddress(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return !BLOCKED_RANGES.has(parsed.range());
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !allowPrivate() && !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new EgressBlockedError(`Blocked request to a private or reserved address (${hostname})`), "", 0);
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 5_000 }, headersTimeout: 15_000, bodyTimeout: 15_000 });

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  finalUrl: string;
}

function assertUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new EgressBlockedError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new EgressBlockedError("Credentials in URLs are not allowed");
  if (!allowPrivate() && url.port && url.port !== "80" && url.port !== "443") {
    throw new EgressBlockedError("Only ports 80 and 443 are allowed");
  }
  // Literal IPs skip DNS, so check them here too.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !allowPrivate() && !isPublicAddress(host)) {
    throw new EgressBlockedError("Blocked request to a private or reserved address");
  }
  return url;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  let url = assertUrl(rawUrl);
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; hop <= 3; hop++) {
    const res = await undiciFetch(url, {
      method,
      headers: { "user-agent": "WorkEasy360-Agents/1.0", ...opts.headers },
      body,
      redirect: "manual",
      signal,
      dispatcher: agent,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = assertUrl(new URL(res.headers.get("location")!, url).toString());
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk as Uint8Array);
        size += buf.length;
        if (size > maxBytes) {
          chunks.push(buf.subarray(0, buf.length - (size - maxBytes)));
          truncated = true;
          break;
        }
        chunks.push(buf);
      }
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.concat(chunks).toString("utf8"),
      truncated,
      finalUrl: url.toString(),
    };
  }
  throw new EgressBlockedError("Too many redirects");
}

/** Fetch as raw bytes (for document import). Same protections as `safeFetch`. */
export async function safeFetchBytes(rawUrl: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  const url = assertUrl(rawUrl);
  const res = await undiciFetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), dispatcher: agent });
  if (res.status >= 300) throw new EgressBlockedError(`URL returned HTTP ${res.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    const buf = Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) throw new EgressBlockedError("File is too large");
    chunks.push(buf);
  }
  return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") ?? "", finalUrl: url.toString() };
}
