-- The admin step-up of a WorkEasy360 session (docs/workeasy360-sso.md, "Admin dashboard: Agents' own second factor"):
-- when this session presented Agents' own TOTP or backup code. Additive and nullable: the previous code ignores it.
ALTER TABLE "session" ADD COLUMN "two_factor_verified_at" timestamp with time zone;
