import { type JobName, type JobPayload, JobPayloadSchemas } from "@ace/db/jobs";
import type { Logger } from "pino";
import type { WorkerJob } from "./deps";

/**
 * Validates a job's payload. An invalid payload can never succeed, so it is logged (name and id only, never
 * the payload) and the caller returns normally: pg-boss completes the job instead of retrying it.
 */
export function parsePayload<N extends JobName>(
  name: N,
  job: WorkerJob,
  logger: Logger,
): JobPayload<N> | null {
  const parsed = JobPayloadSchemas[name].safeParse(job.data);
  if (parsed.success) return parsed.data as JobPayload<N>;
  logger.warn({ job: name, jobId: job.id }, "job.invalid_payload");
  return null;
}
