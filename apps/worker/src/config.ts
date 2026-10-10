import { z } from "zod";

const EnvSchema = z.object({
  /** ace_app: every query is RLS-bound (ADR-005). */
  DATABASE_URL: z.string().startsWith("postgres"),
  ACE_MASTER_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Jobs per queue processed in parallel by this process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Incremental reconcile: repairs a dropped webhook within one interval (Phase 6 exit criterion). */
  RECONCILE_CRON: z.string().min(9).default("*/15 * * * *"),
  /** Full reconcile: also marks products the store removed as deleted. */
  FULL_RECONCILE_CRON: z.string().min(9).default("30 2 * * *"),
  RETENTION_CRON: z.string().min(9).default("0 3 * * *"),
});

export interface WorkerConfig {
  databaseUrl: string;
  masterKey: Buffer;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  concurrency: number;
  reconcileCron: string;
  fullReconcileCron: string;
  retentionCron: string;
  /** Keyless demo models ("demo:*") are allowed only outside production. */
  allowDemoModels: boolean;
}

/** Validates the environment. Errors name the variable and the rule, never the value (it may be a secret). */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid worker configuration: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    masterKey: Buffer.from(e.ACE_MASTER_KEY, "base64"),
    logLevel: e.LOG_LEVEL,
    concurrency: e.WORKER_CONCURRENCY,
    reconcileCron: e.RECONCILE_CRON,
    fullReconcileCron: e.FULL_RECONCILE_CRON,
    retentionCron: e.RETENTION_CRON,
    allowDemoModels: e.NODE_ENV !== "production",
  };
}
