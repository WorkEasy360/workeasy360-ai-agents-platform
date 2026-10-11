import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_ADMIN: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters")
    .refine((v) => !/change-me/i.test(v), "BETTER_AUTH_SECRET is still the .env.example placeholder; generate a random value"),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("WorkEasy360 Agents <no-reply@localhost>"),
  ADMIN_REQUIRE_2FA: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

/**
 * Production safety checks. Each one blocks a misconfiguration that would weaken secret
 * handling: missing KMS, a shared pepper, or a local-only switch left on.
 * Messages name the variable, never its value.
 */
function productionProblems(e: NodeJS.ProcessEnv, nodeEnv: string, appUrl: string): string[] {
  const problems: string[] = [];
  const host = new URL(appUrl).hostname;
  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  if (nodeEnv !== "production") {
    // A public URL with a non-production NODE_ENV would silently enable dev behaviour
    // (mock models, private-network egress, insecure cookies, no email verification).
    if (!isLocalHost && nodeEnv !== "test") problems.push(`NODE_ENV must be "production" when APP_URL is a public address (${host}).`);
    return problems;
  }
  if (!e.KMS_KEY_ID) problems.push("KMS_KEY_ID is required in production (credential encryption).");
  if (e.LOCAL_MASTER_KEY) problems.push("LOCAL_MASTER_KEY must not be set in production; use KMS_KEY_ID.");
  if (!e.API_KEY_PEPPER || e.API_KEY_PEPPER.length < 32) problems.push("API_KEY_PEPPER (32+ characters, separate from BETTER_AUTH_SECRET) is required in production.");
  if (e.API_KEY_PEPPER && e.API_KEY_PEPPER === e.BETTER_AUTH_SECRET) problems.push("API_KEY_PEPPER must differ from BETTER_AUTH_SECRET.");
  for (const flag of ["MOCK_LLM", "ALLOW_PRIVATE_EGRESS"]) if (e[flag] === "true") problems.push(`${flag} must not be enabled in production.`);
  if (e.S3_ENDPOINT) problems.push("S3_ENDPOINT is for local S3 emulators only; unset it in production.");
  if (!appUrl.startsWith("https://")) problems.push("APP_URL must use https in production.");
  return problems;
}

const problems = productionProblems(process.env, parsed.data.NODE_ENV, parsed.data.APP_URL);
if (problems.length) {
  console.error("Unsafe environment configuration:\n- " + problems.join("\n- "));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === "production",
  // Super admins must use 2FA in production; local dev may opt out.
  adminRequire2fa: parsed.data.ADMIN_REQUIRE_2FA ?? parsed.data.NODE_ENV === "production",
};
