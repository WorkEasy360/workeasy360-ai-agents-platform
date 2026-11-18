/**
 * Operator commands for sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md#operator-commands).
 * They run as the schema owner (DATABASE_URL_ADMIN), locally with `pnpm --filter @we360/api workeasy360 <command>`,
 * on the server with `docker compose run --rm api node dist/scripts/workeasy360.js <command>`.
 *
 *   link-organization <agents-organization-id> <workeasy360-organization-id> [--replace-empty]
 *   link-user <agents-user-id> <workeasy360-sub> [--issuer <issuer>]
 *   move-issuer --from <old issuer> --to <new issuer> [--apply]
 *   identities
 */
import { parseArgs } from "node:util";
import { adminDb, closeDb } from "@we360/db";
import { identitiesReport, linkOrganization, linkUser, moveIssuer, type OperatorResult } from "../workeasy360/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "replace-empty": { type: "boolean", default: false },
    issuer: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const usage = `usage:
  workeasy360 link-organization <agents-organization-id> <workeasy360-organization-id> [--replace-empty]
  workeasy360 link-user <agents-user-id> <workeasy360-sub> [--issuer <issuer>]   (default issuer: WORKEASY360_ISSUER)
  workeasy360 move-issuer --from <old issuer> --to <new issuer> [--apply]
  workeasy360 identities`;

async function run(): Promise<OperatorResult> {
  const [command, ...args] = positionals;
  const db = adminDb();
  switch (command) {
    case "link-organization": {
      const [tenantId, organizationId] = args;
      if (!tenantId || !organizationId || !UUID.test(tenantId) || !UUID.test(organizationId)) return { ok: false, message: usage };
      return linkOrganization(db, tenantId.toLowerCase(), organizationId.toLowerCase(), { replaceEmpty: Boolean(values["replace-empty"]) });
    }
    case "link-user": {
      const [userId, subject] = args;
      const issuer = values.issuer ?? process.env.WORKEASY360_ISSUER;
      if (!userId || !subject || !UUID.test(userId)) return { ok: false, message: usage };
      if (!issuer || issuer.endsWith("/")) return { ok: false, message: "--issuer (or WORKEASY360_ISSUER) is required, exactly as the provider names it, without a trailing slash." };
      return linkUser(db, userId.toLowerCase(), subject, issuer);
    }
    case "move-issuer": {
      if (!values.from || !values.to) return { ok: false, message: usage };
      return moveIssuer(db, values.from, values.to, Boolean(values.apply));
    }
    case "identities": {
      const rows = await identitiesReport(db);
      if (!rows.length) return { ok: true, message: "No WorkEasy360 identities yet." };
      return { ok: true, message: rows.map((r) => `${r.issuer}  users=${r.users}  live_sessions=${r.liveSessions}`).join("\n") };
    }
    default:
      return { ok: false, message: usage };
  }
}

try {
  const result = await run();
  (result.ok ? console.log : console.error)(result.message);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await closeDb();
}
