import type { Request, Response } from "express";
import type { z } from "zod";
import { withTenant, type Tx } from "@we360/db";
import { auditLogs } from "@we360/db/schema";
import { AppError } from "./errors";

/** Parses and validates a request part; ZodErrors become 400 problem responses. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

/** Route param as a validated UUID (so bad ids are 404s, not database errors). */
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw AppError.notFound();
  }
  return value;
}

export function tenantOf(req: Request) {
  if (!req.tenant) throw AppError.unauthorized();
  return req.tenant;
}

/** Opens a Server-Sent Events stream. `send` is a no-op once the client disconnects. */
export function openSse(req: Request, res: Response) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  let open = true;
  req.on("close", () => (open = false));
  const ping = setInterval(() => open && res.write(": ping\n\n"), 15_000);
  return {
    send(event: { type: string } & Record<string, unknown>) {
      if (open) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(ping);
      if (open) res.end();
    },
  };
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  diff?: unknown;
}

/** Writes an audit entry for the current tenant request. Pass `tx` to join an open transaction. */
export async function audit(req: Request, entry: AuditEntry, tx?: Tx) {
  const tenant = tenantOf(req);
  const row = {
    orgId: tenant.orgId,
    actorType: req.auth ? "user" : "api_key",
    actorId: req.auth?.user.id ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    diff: entry.diff,
    ip: req.ip,
    userAgent: req.header("user-agent")?.slice(0, 300),
  };
  if (tx) await tx.insert(auditLogs).values(row);
  else await withTenant(tenant.orgId, (t) => t.insert(auditLogs).values(row));
}
