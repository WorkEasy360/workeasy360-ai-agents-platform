import { Queue, Worker } from "bullmq";
import { closeDb } from "@we360/db";
import { closeQueues, type IngestJob, QUEUE_PREFIX, redis, type RunJob, type RunJobResult } from "./lib/queue";
import { logger } from "./lib/logger";
import { ingestDocument } from "./modules/knowledge/ingestion";
import { deletePrefix } from "./lib/storage";
import { applyRetention, purgeDeleted } from "./modules/privacy/retention";
import { executeRunJob } from "./modules/runs/async-runs";

/**
 * Background worker: document ingestion and nightly maintenance.
 * Same codebase as the API, separate process (`pnpm worker` / its own ECS service).
 */

const ingest = new Worker<IngestJob>(
  "ingest",
  async (job) => {
    await ingestDocument(job.data.orgId, job.data.documentId);
  },
  { connection: redis(),
  prefix: QUEUE_PREFIX, concurrency: Number(process.env.INGEST_CONCURRENCY ?? 2) },
);
ingest.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message }, "ingest job failed"));
ingest.on("completed", (job) => logger.info({ documentId: job.data.documentId }, "document ingested"));

// Async API runs (POST /runs/agents/:id with async: true).
const runs = new Worker<RunJob, RunJobResult>("runs", (job) => executeRunJob(job.data), {
  connection: redis(),
  prefix: QUEUE_PREFIX,
  concurrency: Number(process.env.RUN_CONCURRENCY ?? 10),
});
runs.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message }, "async run job failed"));

const maintenanceQueue = new Queue("maintenance", { connection: redis(), prefix: QUEUE_PREFIX });
await maintenanceQueue.upsertJobScheduler("retention", { pattern: "0 2 * * *", tz: "Asia/Kolkata" }, { name: "retention" });
await maintenanceQueue.upsertJobScheduler("purge-deleted", { pattern: "30 2 * * *", tz: "Asia/Kolkata" }, { name: "purge-deleted" });
const maintenance = new Worker(
  "maintenance",
  async (job) => {
    if (job.name === "retention") await applyRetention();
    if (job.name === "purge-deleted") await purgeDeleted();
    if (job.name === "files-cleanup") {
      const { prefix } = job.data as { prefix: string };
      const count = await deletePrefix(prefix);
      logger.info({ count }, "files deleted");
    }
    if (job.name === "org-cleanup") {
      const { orgId } = job.data as { orgId: string };
      const count = await deletePrefix(`org/${orgId}/`);
      logger.info({ orgId, count }, "organization files deleted");
    }
  },
  { connection: redis(), prefix: QUEUE_PREFIX },
);

logger.info("worker started");

async function shutdown() {
  await Promise.all([ingest.close(), runs.close(), maintenance.close(), maintenanceQueue.close()]);
  await closeQueues();
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
