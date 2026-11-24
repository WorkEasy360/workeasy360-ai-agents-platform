import { env } from "../config/env";
import { logger } from "../lib/logger";
import { Workeasy360Client } from "./client";
import { loadWorkeasy360Settings, type Workeasy360Settings } from "./config";
import { EntitlementCache, type AnswerStore } from "./entitlements";
import { getEntitlementAnswer, putEntitlementAnswer } from "./store";

/** Everything the routes and middleware need for WorkEasy360 sign-in in this process. */
export interface Workeasy360Runtime {
  client: Workeasy360Client;
  entitlements: EntitlementCache;
  settings: Workeasy360Settings;
}

/** Entitlement answers shared by every API instance, in PostgreSQL (`workeasy360_entitlements`). */
export const postgresAnswerStore: AnswerStore = {
  get: (key) => getEntitlementAnswer(key),
  set: (key, value, ttlSeconds) => putEntitlementAnswer(key, value, ttlSeconds),
};

export function createWorkeasy360Runtime(
  settings: Workeasy360Settings,
  extras: { store?: AnswerStore; cacheNow?: () => number } = {},
): Workeasy360Runtime {
  const client = new Workeasy360Client({
    issuer: settings.issuer,
    clientId: settings.clientId,
    productCode: settings.productCode,
    redirectUri: settings.redirectUri,
    keyId: settings.keyId,
    privateKeyPem: settings.privateKeyPem,
    scopes: settings.scopes,
    allowInsecureRequests: settings.allowInsecureRequests,
  });
  return {
    client,
    entitlements: new EntitlementCache(client, extras.store ?? postgresAnswerStore, logger, extras.cacheNow),
    settings,
  };
}

/** From the WORKEASY360_* environment; undefined when WorkEasy360 sign-in is off. Throws when misconfigured. */
export function runtimeFromEnv(): Workeasy360Runtime | undefined {
  const settings = loadWorkeasy360Settings(process.env, { appUrl: env.APP_URL, production: env.isProduction });
  return settings ? createWorkeasy360Runtime(settings) : undefined;
}

let current: Workeasy360Runtime | undefined;

/**
 * The process's WorkEasy360 runtime. Set once by createApp (from the environment, or by a test);
 * read by the Better Auth plugin, requireSession / requireTenant and the back-channel receiver.
 */
export function setWorkeasy360Runtime(runtime: Workeasy360Runtime | undefined): void {
  current = runtime;
}

export function getWorkeasy360Runtime(): Workeasy360Runtime | undefined {
  return current;
}
