import { JOBS } from "@ace/db/jobs";
import type { PgBoss } from "pg-boss";

export interface ScheduleCrons {
  reconcileCron: string;
  fullReconcileCron: string;
  retentionCron: string;
}

/**
 * Upserted on every start (pg-boss keys a schedule by queue name + key), so changed crons take effect on
 * restart. Two schedules share sync.reconcile-all, told apart by `key`. The incremental run is every 15
 * minutes so a dropped webhook is repaired within one interval; the nightly full run also marks deletions.
 */
export async function registerSchedules(boss: Pick<PgBoss, "schedule">, crons: ScheduleCrons): Promise<void> {
  await boss.schedule(JOBS.syncReconcileAll, crons.reconcileCron, { full: false }, { key: "incremental" });
  await boss.schedule(JOBS.syncReconcileAll, crons.fullReconcileCron, { full: true }, { key: "full" });
  await boss.schedule(JOBS.retentionPurge, crons.retentionCron, {});
}
