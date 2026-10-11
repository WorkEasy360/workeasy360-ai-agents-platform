import { Queue } from "bullmq";
import { Redis } from "ioredis";

let connection: Redis | undefined;

/** Key prefix for all queues. Tests use their own so a running dev worker never picks up test jobs. */
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX ?? "bull";

/** Shared Redis connection for queues. BullMQ requires maxRetriesPerRequest = null. */
export function redis(): Redis {
  connection ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  return connection;
}

export interface IngestJob {
  orgId: string;
  documentId: string;
}

let ingestQueue: Queue<IngestJob> | undefined;

export function getIngestQueue(): Queue<IngestJob> {
  ingestQueue ??= new Queue<IngestJob>("ingest", { connection: redis(), prefix: QUEUE_PREFIX });
  return ingestQueue;
}

export async function enqueueIngest(job: IngestJob) {
  await getIngestQueue().add("document", job, {
    // One job per document at a time; re-adding while queued is a no-op.
    jobId: `doc-${job.documentId}-${Date.now()}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

/** An API run requested with `async: true`. Not retried: runs have side effects (tools, emails). */
export interface RunJob {
  orgId: string;
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  apiKeyId?: string;
  message: string;
  conversationId?: string;
  endUserRef?: string;
  callbackUrl?: string;
}

export interface RunJobResult {
  executionId?: string;
  conversationId?: string;
  status: "succeeded" | "limited" | "failed";
  output?: string;
  citations?: Array<{ title: string; documentId: string }>;
  error?: { code: string; message: string };
  webhook?: { delivered: boolean; attempts: number; lastStatus?: number };
}

let runsQueue: Queue<RunJob, RunJobResult> | undefined;

export function getRunsQueue(): Queue<RunJob, RunJobResult> {
  runsQueue ??= new Queue<RunJob, RunJobResult>("runs", { connection: redis(), prefix: QUEUE_PREFIX });
  return runsQueue;
}

let maintenanceQueue: Queue | undefined;

export function getMaintenanceQueue(): Queue {
  maintenanceQueue ??= new Queue("maintenance", { connection: redis(), prefix: QUEUE_PREFIX });
  return maintenanceQueue;
}

/** Removes an organization's files after it is deleted (database rows cascade on their own). */
export async function enqueueOrgCleanup(orgId: string) {
  await getMaintenanceQueue().add("org-cleanup", { orgId }, { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 100 });
}

/** Removes every uploaded file under a prefix (e.g. a deleted knowledge base). Retried if S3 is unavailable. */
export async function enqueueFileCleanup(prefix: string) {
  if (!prefix.startsWith("org/") || !prefix.endsWith("/")) throw new Error(`Refusing to clean up prefix ${prefix}`);
  await getMaintenanceQueue().add("files-cleanup", { prefix }, { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 100 });
}

export async function closeQueues() {
  await maintenanceQueue?.close();
  await ingestQueue?.close();
  await runsQueue?.close();
  await connection?.quit();
}
