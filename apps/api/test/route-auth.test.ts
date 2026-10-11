import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { organization, user } from "@we360/db/schema";
import { closeQueues } from "../src/lib/queue";
import { app, signUpWithOrg } from "./helpers";

/**
 * Every route, discovered from the source (so new routes are covered automatically), must refuse
 * a request with no session or API key. Public routes are listed explicitly.
 */
const SRC = join(__dirname, "../src");
const PUBLIC_PREFIXES = ["/api/public/v1"]; // hosted page / widget, by design

function routes() {
  const appSrc = readFileSync(join(SRC, "app.ts"), "utf8");
  const mounts = [...appSrc.matchAll(/app\.use\("([^"]+)",\s*(\w+Router)\)/g)].map((m) => ({ prefix: m[1]!, router: m[2]! }));
  const files = readdirSync(join(SRC, "modules"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".routes.ts"));
  const out: Array<{ method: string; path: string; prefix: string }> = [];
  for (const f of files) {
    const text = readFileSync(join(SRC, "modules", f), "utf8");
    for (const { prefix, router } of mounts) {
      if (!text.includes(`export const ${router} = Router()`)) continue;
      for (const m of text.matchAll(new RegExp(`${router}\\.(get|post|put|patch|delete)\\(\\s*"([^"]+)"`, "g"))) {
        out.push({ method: m[1]!, path: (prefix + m[2]!).replace(/:\w+/g, "00000000-0000-4000-8000-000000000000"), prefix });
      }
    }
  }
  return out;
}

let customer: Awaited<ReturnType<typeof signUpWithOrg>> | undefined;

afterAll(async () => {
  if (customer) {
    await adminDb().delete(organization).where(eq(organization.id, customer.orgId));
    await adminDb().delete(user).where(eq(user.id, customer.userId));
  }
  await closeQueues();
  await closeDb();
});

describe("route authentication", () => {
  const all = routes();

  it("discovers the API surface", () => {
    expect(all.length).toBeGreaterThan(80);
  });

  it.each(all.filter((r) => !PUBLIC_PREFIXES.includes(r.prefix)).map((r) => [r.method.toUpperCase(), r.path, r.prefix]))(
    "%s %s refuses anonymous requests",
    async (method, path) => {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path)
        .set("Origin", "http://localhost:3000")
        .send({});
      expect(res.status).toBe(401);
      // Never an internal error or a stack trace.
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
    },
  );

  it("hides every admin route (404) from signed-in customers", async () => {
    customer = await signUpWithOrg("route-auth");
    const admin = all.filter((r) => r.prefix === "/api/admin/v1");
    expect(admin.length).toBeGreaterThan(20);
    for (const r of admin) {
      const res = await (customer.agent as unknown as Record<string, (p: string) => request.Test>)[r.method]!(r.path).set("Origin", "http://localhost:3000").send({});
      expect(`${r.method} ${r.path} ${res.status}`).toBe(`${r.method} ${r.path} 404`);
    }
  });

  it("invalidates the session on the server at sign-out (a copied cookie stops working)", async () => {
    const who = await signUpWithOrg("route-auth-logout");
    const me = await who.agent.get("/api/v1/me");
    expect(me.status).toBe(200);
    const cookie = String(me.request.cookies ?? "");
    expect(cookie).toContain("session_token");
    await who.agent.post("/api/auth/sign-out").set("Origin", "http://localhost:3000").send({}).expect(200);
    const replay = await request(app).get("/api/v1/me").set("Cookie", cookie);
    expect(replay.status).toBe(401);
    await adminDb().delete(organization).where(eq(organization.id, who.orgId));
    await adminDb().delete(user).where(eq(user.id, who.userId));
  });
});
