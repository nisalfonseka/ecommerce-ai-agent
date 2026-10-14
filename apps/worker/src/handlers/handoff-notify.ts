import { getHandoff, getTenantSettings, markHandoffNotified, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { NotifyError } from "@ace/notify";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

export async function handleHandoffNotify(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.handoffNotify, job, deps.logger);
  if (!payload) return;
  const state = await withTenant(deps.db, payload.tenantId, async (tx) => ({
    handoff: await getHandoff(tx, payload.handoffId),
    settings: await getTenantSettings(tx),
  }));
  if (!state.handoff || state.handoff.notifiedAt) return;

  const recipients = state.settings.handoffEmails;
  if (recipients.length === 0) {
    deps.logger.warn(
      { job: JOBS.handoffNotify, jobId: job.id, tenantId: payload.tenantId, handoffId: payload.handoffId },
      "handoff alert has no recipients",
    );
  } else {
    const link = new URL(`/handoffs/${payload.handoffId}`, deps.dashboardBaseUrl).toString();
    const subject = `New support handoff: ${state.handoff.reason}`;
    const text = [
      `Reason: ${state.handoff.reason}`,
      `Summary: ${state.handoff.summary}`,
      `Open in the staff dashboard: ${link}`,
    ].join("\n\n");
    for (const to of recipients) {
      try {
        await deps.notifier.sendEmail({ to, subject, text });
      } catch (error) {
        if (
          error instanceof NotifyError &&
          (error.code === "rejected" || error.code === "invalid_destination")
        ) {
          deps.logger.error(
            {
              job: JOBS.handoffNotify,
              jobId: job.id,
              tenantId: payload.tenantId,
              handoffId: payload.handoffId,
              errorCode: error.code,
            },
            "handoff alert rejected",
          );
          continue;
        }
        throw error;
      }
    }
  }

  await withTenant(deps.db, payload.tenantId, (tx) => markHandoffNotified(tx, payload.handoffId, deps.now()));
}
