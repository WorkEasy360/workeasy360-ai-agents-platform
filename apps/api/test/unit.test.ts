import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/lib/safe-fetch";
import { chunkSections } from "../src/modules/knowledge/chunker";
import { htmlToText } from "../src/modules/knowledge/parsers";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { serializeRequest, truncateIp } from "../src/lib/logger";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password";
import { hashPassword as scryptHash } from "better-auth/crypto";

describe("SSRF address checks", () => {
  it.each([
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.10", false],
    ["169.254.169.254", false], // cloud metadata
    ["100.64.0.1", false], // carrier-grade NAT
    ["0.0.0.0", false],
    ["::1", false],
    ["fc00::1", false],
    ["::ffff:127.0.0.1", false], // IPv4-mapped loopback
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["2606:4700:4700::1111", true],
  ])("%s is public: %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe("chunker", () => {
  it("keeps heading context and respects the size limit", () => {
    const text = ["# Returns", "", "Para one. ".repeat(50), "", "## Exceptions", "", "Para two. ".repeat(50)].join("\n");
    const chunks = chunkSections([{ text }], 100, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 100 * 4 + 50)).toBe(true);
    expect(chunks.at(-1)!.metadata.headingPath).toEqual(["Returns", "Exceptions"]);
  });

  it("carries the PDF page number", () => {
    const chunks = chunkSections([{ text: "Hello world", page: 3 }]);
    expect(chunks[0]!.metadata.page).toBe(3);
  });
});

describe("html to text", () => {
  it("drops scripts and keeps headings", () => {
    const out = htmlToText("<html><script>alert(1)</script><h2>Pricing</h2><p>Starts at &amp; ₹999</p></html>");
    expect(out).not.toContain("alert");
    expect(out).toContain("## Pricing");
    expect(out).toContain("Starts at & ₹999");
  });
});

describe("secret encryption", () => {
  it("round-trips and uses a fresh data key per secret", async () => {
    const a = await encryptSecret("sk-test-123456");
    const b = await encryptSecret("sk-test-123456");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(await decryptSecret(a)).toBe("sk-test-123456");
  });

  it("rejects tampered ciphertext", async () => {
    const s = await encryptSecret("secret-value");
    s.ciphertext[0] = s.ciphertext[0]! ^ 0xff;
    await expect(decryptSecret(s)).rejects.toThrow();
  });

  it("rejects a truncated authentication tag", async () => {
    const s = await encryptSecret("secret-value");
    await expect(decryptSecret({ ...s, authTag: s.authTag.subarray(0, 4) })).rejects.toThrow();
  });
});

describe("secret hygiene", () => {
  it("redacts one-time tokens from logged URLs", async () => {
    const { redactUrl } = await import("../src/lib/logger");
    expect(redactUrl("/api/auth/reset-password/abc123secret?callbackURL=%2Freset")).toBe("/api/auth/reset-password/[redacted]?callbackURL=/reset");
    expect(redactUrl("/api/auth/verify-email?token=eyJhbGci.x.y&callbackURL=/")).not.toContain("eyJhbGci");
    expect(redactUrl("/api/auth/callback/google?code=4/0AX&state=s1")).not.toMatch(/4\/0AX|s1/);
    expect(redactUrl("/api/v1/agents?limit=5")).toBe("/api/v1/agents?limit=5");
  });

  it("rejects secrets typed into API tool config instead of a credential", async () => {
    const { httpConfigSchema } = await import("../src/runtime/tools/http-request");
    const base = { method: "GET" as const, url: "https://api.example.com/orders/{id}" };
    expect(httpConfigSchema.safeParse({ ...base, headers: { Authorization: "Bearer sk-live-123" } }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ ...base, headers: { "X-Api-Key": "abc" } }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ ...base, url: "https://api.example.com/x?api_key=abc123" }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ ...base, url: "https://user:pw@api.example.com/x" }).success).toBe(false);
    // Non-secret headers and model-filled placeholders are fine.
    expect(httpConfigSchema.safeParse({ ...base, headers: { Accept: "application/json" } }).success).toBe(true);
    expect(httpConfigSchema.safeParse({ ...base, url: "https://api.example.com/x?token={token}" }).success).toBe(true);
  });

  it("summarises errors without request payloads", async () => {
    const { errSummary } = await import("../src/lib/logger");
    const err = Object.assign(new Error("Bad request"), { requestBodyValues: { prompt: "customer data" }, statusCode: 400 });
    const s = errSummary(err);
    expect(JSON.stringify(s)).not.toContain("customer data");
    expect(s.statusCode).toBe(400);
  });
});

describe("request logs", () => {
  it("shortens IP addresses", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0");
    expect(truncateIp("::ffff:198.51.100.9")).toBe("198.51.100.0");
    expect(truncateIp("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::/48");
  });

  it("logs only allow-listed headers", () => {
    const out = serializeRequest({
      method: "GET",
      url: "/api/auth/reset-password/abc123?callbackURL=/x",
      headers: {
        host: "app.example.com",
        "user-agent": "Mozilla/5.0",
        referer: "https://shop.example.com/orders?email=asha@example.com",
        "x-forwarded-for": "203.0.113.77",
        cookie: "session=secret",
        origin: "https://shop.example.com/some/path",
        "x-custom-thing": "whatever",
      },
      raw: { ip: "203.0.113.77" },
    });
    expect(Object.keys(out.headers).sort()).toEqual(["host", "origin", "user-agent"]);
    expect(out.headers.origin).toBe("https://shop.example.com");
    expect(out.ip).toBe("203.0.113.0");
    expect(out.url).not.toContain("abc123");
    expect(JSON.stringify(out)).not.toContain("asha@");
  });
});

describe("password hashing", () => {
  it("hashes with Argon2id at OWASP parameters and verifies", async () => {
    const h = await hashPassword("correct-horse-battery");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword({ hash: h, password: "correct-horse-battery" })).toBe(true);
    expect(await verifyPassword({ hash: h, password: "wrong-password" })).toBe(false);
  });

  it("still verifies older scrypt hashes and flags them for upgrade", async () => {
    const legacy = await scryptHash("correct-horse-battery");
    expect(needsRehash(legacy)).toBe(true);
    expect(await verifyPassword({ hash: legacy, password: "correct-horse-battery" })).toBe(true);
    expect(await verifyPassword({ hash: legacy, password: "wrong-password" })).toBe(false);
  });
});
