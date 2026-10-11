import type { RequestHandler } from "express";
import { AppError } from "./errors";
import { redis } from "./queue";

/**
 * Fixed-window rate limit in Redis. `key` picks the bucket (per API key, per visitor IP, ...).
 * If Redis is down we fail open: plan quotas in Postgres still cap spend.
 */
export function rateLimit(opts: { name: string; limit: number; windowSec: number; key: (req: Parameters<RequestHandler>[0]) => string }): RequestHandler {
  return async (req, res, next) => {
    const window = Math.floor(Date.now() / 1000 / opts.windowSec);
    const bucket = `rl:${opts.name}:${opts.key(req)}:${window}`;
    try {
      const count = await redis().incr(bucket);
      if (count === 1) await redis().expire(bucket, opts.windowSec + 1);
      res.setHeader("RateLimit-Limit", String(opts.limit));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.limit - count)));
      if (count > opts.limit) {
        res.setHeader("Retry-After", String(opts.windowSec));
        return next(new AppError(429, "rate_limited", "Too many requests. Please slow down."));
      }
    } catch {
      // Fail open.
    }
    next();
  };
}

/**
 * Per signed-in user (within the active org) for endpoints that cost money or do outbound work:
 * model calls, embeddings, file processing, provider key checks. Use after requireSession/requireTenant.
 */
export function perUserLimit(name: string, limit: number, windowSec = 60): RequestHandler {
  return rateLimit({ name, limit, windowSec, key: (req) => `${req.tenant?.orgId ?? "-"}:${req.auth?.user.id ?? req.ip ?? "unknown"}` });
}
