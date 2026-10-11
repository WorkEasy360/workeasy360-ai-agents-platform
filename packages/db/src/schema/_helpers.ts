import { sql } from "drizzle-orm";
import { customType, pgPolicy, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export const id = () =>
  uuid("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey();

export const tz = (name: string) => timestamp(name, { withTimezone: true });

export const timestamps = {
  createdAt: tz("created_at").defaultNow().notNull(),
  updatedAt: tz("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

export const createdBy = () => uuid("created_by").references(() => user.id, { onDelete: "set null" });

export const deletedAt = () => tz("deleted_at");

/**
 * Row-level security for tenant tables. The API sets `app.org_id` per transaction (see `withTenant`);
 * when it is unset, the expression is NULL and no rows are visible or writable.
 * The schema owner (`agents_owner`) is not subject to RLS and is used only by the worker, migrations and
 * the super admin API; the API's tenant requests use `agents_app`, which RLS restricts.
 */
export const tenantPolicy = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    using: sql`org_id = nullif(current_setting('app.org_id', true), '')::uuid`,
    withCheck: sql`org_id = nullif(current_setting('app.org_id', true), '')::uuid`,
  });

export const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
