import { z } from "zod";
import { EgressBlockedError, safeFetch } from "../../lib/safe-fetch";
import type { RuntimeTool, ToolProviderDefinition } from "./types";
import { truncateForModel } from "./types";

/**
 * "Custom API" tool: calls one HTTP endpoint the user configured.
 * Model inputs fill `{placeholders}` in the URL; remaining inputs go to the query string
 * (GET/DELETE) or a JSON body (POST/PUT/PATCH). Auth comes from a stored credential.
 */

export const httpParamSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/, "Use letters, numbers and underscores"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().max(500).default(""),
  required: z.boolean().default(false),
});

/** Header and query names that carry secrets. Those belong in an encrypted credential, never in plain tool config. */
const SECRET_NAME = /(^authorization$|^proxy-authorization$|^cookie$|token|secret|passw|api[-_]?key|apikey|^key$|signature|session)/i;
const CREDENTIAL_HINT = "Put secrets in a Credential (Tools → Credentials) and attach it to the tool instead.";

export const httpConfigSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.url().max(2000),
    headers: z.record(z.string().max(100), z.string().max(2000)).default({}),
    params: z.array(httpParamSchema).max(30).default([]),
    timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
  })
  .superRefine((cfg, ctx) => {
    for (const name of Object.keys(cfg.headers)) {
      if (SECRET_NAME.test(name)) {
        ctx.addIssue({ code: "custom", path: ["headers", name], message: `The "${name}" header looks like a secret. ${CREDENTIAL_HINT}` });
      }
    }
    // The model fills placeholders, so they may only appear in the path or query: a placeholder in the
    // host would let prompt-injected text choose where the attached credential is sent.
    if (/\{/.test(templateOrigin(cfg.url))) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Placeholders like {name} can only be used in the path or query, not in the website address." });
    }
    let url: URL | undefined;
    try {
      url = new URL(cfg.url.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "x"));
    } catch {
      return;
    }
    if (url.username || url.password) ctx.addIssue({ code: "custom", path: ["url"], message: `URLs can't contain a username or password. ${CREDENTIAL_HINT}` });
    for (const [name, value] of url.searchParams) {
      // A {placeholder} filled in by the model is fine; a fixed value with a secret-like name isn't.
      if (SECRET_NAME.test(name) && value !== "x") {
        ctx.addIssue({ code: "custom", path: ["url"], message: `The "${name}" URL parameter looks like a secret. ${CREDENTIAL_HINT}` });
      }
    }
  });
export type HttpToolConfig = z.infer<typeof httpConfigSchema>;

/** "scheme://host:port" part of a URL template (everything before the path, query or fragment). */
function templateOrigin(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0] ?? url;
}

export const httpRequestDefinition: ToolProviderDefinition = {
  key: "http_request",
  displayName: "Custom API",
  description: "Call an HTTP endpoint, for example to look up an order or create a lead in your system.",
  configSchema: z.toJSONSchema(httpConfigSchema) as Record<string, unknown>,
  supportsCredential: true,
};

export function inputSchemaFromParams(params: HttpToolConfig["params"]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, description: p.description }])),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

export interface HttpAuth {
  authType: string; // bearer | api_key | basic | header
  secret: string;
  headerName?: string;
}

export function buildHttpTool(row: {
  name: string;
  description: string;
  config: HttpToolConfig;
  sideEffect: "read" | "write";
  requiresApproval: boolean;
  auth?: HttpAuth;
}): RuntimeTool {
  const { config } = row;
  return {
    name: row.name,
    description: row.description,
    inputSchema: inputSchemaFromParams(config.params),
    sideEffect: row.sideEffect,
    requiresApproval: row.requiresApproval,
    async execute(input) {
      const remaining: Record<string, unknown> = { ...input };
      // "." and ".." survive encodeURIComponent and would move the request to a different path.
      const unsafe = Object.entries(input).find(([, v]) => v === "." || v === "..");
      if (unsafe) return { forModel: { ok: false, error: `Invalid value for ${unsafe[0]}.` }, forTrace: { error: `rejected path segment for ${unsafe[0]}` } };
      let url = config.url.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, key: string) => {
        const v = remaining[key];
        delete remaining[key];
        return encodeURIComponent(v === undefined ? "" : String(v));
      });
      // Tools saved before host placeholders were rejected: never send to a host other than the configured one.
      const configured = templateOrigin(config.url);
      if (configured.includes("{") || new URL(url).origin !== new URL(configured).origin) {
        return { forModel: { ok: false, error: "This tool's address is invalid." }, forTrace: { error: "blocked: request host differs from the configured host" } };
      }

      const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9", ...config.headers };
      if (row.auth) {
        const { authType, secret, headerName } = row.auth;
        if (authType === "bearer") headers.authorization = `Bearer ${secret}`;
        else if (authType === "basic") headers.authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
        else headers[headerName || "x-api-key"] = secret;
      }

      let body: string | undefined;
      if (config.method === "GET" || config.method === "DELETE") {
        const u = new URL(url);
        for (const [k, v] of Object.entries(remaining)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        url = u.toString();
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(remaining);
      }

      try {
        const res = await safeFetch(url, { method: config.method, headers, body, timeoutMs: config.timeoutMs, maxBytes: 200_000 });
        let data: unknown = res.body;
        try {
          data = JSON.parse(res.body);
        } catch {
          // Not JSON; pass text through.
        }
        const text = typeof data === "string" ? data : JSON.stringify(data);
        return {
          forModel: { status: res.status, ok: res.status < 400, body: truncateForModel(text) },
          forTrace: { request: { method: config.method, url: redactUrl(url) }, status: res.status, truncated: res.truncated },
        };
      } catch (err) {
        // undici wraps errors from the DNS check in `cause`.
        const blocked = [err, (err as { cause?: unknown }).cause].find((e) => e instanceof EgressBlockedError) as Error | undefined;
        const message = blocked ? blocked.message : `Request failed: ${(err as Error).message}`;
        return { forModel: { ok: false, error: message }, forTrace: { request: { method: config.method, url: redactUrl(url) }, error: message } };
      }
    },
  };
}

/** Hide query values in traces; they may contain user data. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of u.searchParams.keys()) u.searchParams.set(k, "…");
    return u.toString();
  } catch {
    return raw;
  }
}
