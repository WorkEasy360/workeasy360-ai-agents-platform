// Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md). None of these tables has `org_id`, so none
// is a tenant table: like the Better Auth tables, they are read by the API before a tenant is known.

import { sql } from "drizzle-orm";
import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tz } from "./_helpers";
import { organization, user } from "./auth";

/**
 * A WorkEasy360 person, linked to an Agents user on (issuer, subject). Never on email: an Agents account
 * with the same email address is a different account until an operator links it (`link-user`).
 */
export const workeasy360Identities = pgTable(
  "workeasy360_identities",
  {
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `sign_in` (created by a first WorkEasy360 sign-in) or `operator` (link-user). */
    linkedBy: text("linked_by").notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
    lastSignInAt: tz("last_sign_in_at"),
  },
  (t) => [primaryKey({ columns: [t.issuer, t.subject] }), index("workeasy360_identities_user_idx").on(t.userId)],
);

/**
 * A WorkEasy360 organization and the one Agents organization (tenant) it maps to. Created by the
 * organization's first sign-in (WORKEASY360_PROVISION_TENANTS) or by an operator (`link-organization`).
 * Organization ids are the platform's and do not change when the issuer's name does.
 */
export const workeasy360Organizations = pgTable("workeasy360_organizations", {
  organizationId: uuid("organization_id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  linkedBy: text("linked_by").notNull(),
  createdAt: tz("created_at").defaultNow().notNull(),
});

/** A sign-in between the redirect to WorkEasy360 and the callback: single use, ten minutes. */
export const workeasy360LoginFlows = pgTable(
  "workeasy360_login_flows",
  {
    /** SHA-256 of the random id the browser holds in its flow cookie. */
    idHash: text("id_hash").primaryKey(),
    state: text("state").notNull(),
    nonce: text("nonce").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    /** The organization the launcher named (`?organization=`), if any. */
    organizationId: uuid("organization_id"),
    returnTo: text("return_to"),
    expiresAt: tz("expires_at").notNull(),
  },
  (t) => [index("workeasy360_login_flows_expires_idx").on(t.expiresAt)],
);

/** Logout tokens already acted on, so a replayed `jti` changes nothing. Kept until the token could no longer verify. */
export const workeasy360LogoutTokens = pgTable(
  "workeasy360_logout_tokens",
  {
    issuer: text("issuer").notNull(),
    jti: text("jti").notNull(),
    receivedAt: tz("received_at").defaultNow().notNull(),
    expiresAt: tz("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.issuer, t.jti] }), index("workeasy360_logout_tokens_expires_idx").on(t.expiresAt)],
);

/** The platform's last entitlement answers, shared by every API instance (null expiry: a denial, kept). */
export const workeasy360Entitlements = pgTable("workeasy360_entitlements", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: tz("expires_at"),
  updatedAt: tz("updated_at").default(sql`now()`).notNull(),
});
