/**
 * Creates or promotes a platform staff account. There is no other path to super admin.
 *
 *   ADMIN_PASSWORD='...' pnpm admin:create --email ops@example.com --name "Ops" [--role support]
 *
 * Prefer ADMIN_PASSWORD over --password: command-line arguments end up in shell history and process lists.
 *
 * If the user already exists, only the role changes (password is ignored).
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { auditLogs, user } from "@we360/db/schema";
import { closeQueues } from "../lib/queue";
import { auth } from "../auth/auth";
import { permitSignupForAdminCli } from "../auth/hooks";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string", default: "Platform Admin" },
    password: { type: "string" },
    role: { type: "string", default: "super_admin" },
  },
});

const email = values.email?.toLowerCase().trim();
const role = values.role!;
if (!email) throw new Error("--email is required");
if (role !== "super_admin" && role !== "support") throw new Error("--role must be super_admin or support");

const db = adminDb();
let [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));

const password = process.env.ADMIN_PASSWORD || values.password;
if (!existing) {
  if (!password || password.length < 12) {
    throw new Error("New staff accounts need a password of 12+ characters in ADMIN_PASSWORD (or --password)");
  }
  // Staff accounts are created here even when public sign-up is closed.
  permitSignupForAdminCli();
  await auth.api.signUpEmail({ body: { email, password, name: values.name! } });
  [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  console.log(`Created user ${email}`);
}

await db.update(user).set({ platformRole: role, emailVerified: true }).where(eq(user.id, existing!.id));
await db.insert(auditLogs).values({
  actorType: "system",
  actorId: "cli:admin:create",
  action: "admin.platform_role.granted",
  targetType: "user",
  targetId: existing!.id,
  diff: { platformRole: role },
});
console.log(`${email} is now ${role}. Enable 2FA on first login (required in production).`);
await closeDb();
await closeQueues(); // the sign-up queued a verification email; release Redis so the process exits
