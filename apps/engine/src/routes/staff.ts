import { type Db, getHandoff, listDisplay, listHandoffs, withTenant } from "@ace/db";
import type { JobQueue } from "@ace/db/jobs";
import type { Hono } from "hono";
import { z } from "zod";
import { authenticateStaff } from "../auth/staff";
import type { WidgetEnv } from "../auth/widget";
import { claimHandoff, handBack, resolveHandoff, staffReply } from "../handoff/service";
import { errorResponse } from "../http-errors";

export interface StaffDeps {
  db: Db;
  jobs: JobQueue;
}

const UUID = z.uuid();
const Status = z.enum(["open", "claimed", "resolved"]);
const ReplyBody = z.strictObject({ text: z.string().trim().min(1).max(2_000) });

const present = (row: Awaited<ReturnType<typeof getHandoff>>) =>
  row && {
    id: row.id,
    conversationId: row.conversationId,
    reason: row.reason,
    summary: row.summary,
    status: row.status,
    createdAt: row.createdAt,
    claimedBy: row.claimedBy,
  };

export function registerStaffRoutes(app: Hono<WidgetEnv>, deps: StaffDeps): void {
  const staff = app.basePath("/staff/v1");

  const identity = (authorization: string | undefined) => authenticateStaff(deps.db, authorization);

  staff.get("/handoffs", async (c) => {
    const actor = await identity(c.req.header("authorization"));
    if (!actor) return errorResponse(c, 401, "unauthorized", "Staff token required.");
    const status = c.req.query("status");
    if (status !== undefined && !Status.safeParse(status).success) {
      return errorResponse(c, 400, "invalid_input", "Invalid handoff status.");
    }
    const cursorId = c.req.query("cursor");
    if (cursorId !== undefined && !UUID.safeParse(cursorId).success) {
      return errorResponse(c, 400, "invalid_input", "Invalid cursor.");
    }
    const rows = await withTenant(deps.db, actor.tenantId, async (tx) => {
      const cursor = cursorId ? await getHandoff(tx, cursorId) : null;
      if (cursorId && !cursor) return null;
      return listHandoffs(tx, {
        status: status ? [Status.parse(status)] : undefined,
        cursor: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : undefined,
      });
    });
    if (!rows) return errorResponse(c, 400, "invalid_input", "Invalid cursor.");
    return c.json(rows.map(present));
  });

  staff.get("/handoffs/:id", async (c) => {
    const actor = await identity(c.req.header("authorization"));
    if (!actor) return errorResponse(c, 401, "unauthorized", "Staff token required.");
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return errorResponse(c, 404, "not_found", "Handoff not found.");
    const detail = await withTenant(deps.db, actor.tenantId, async (tx) => {
      const row = await getHandoff(tx, id);
      return row ? { ...present(row), messages: await listDisplay(tx, row.conversationId) } : null;
    });
    return detail ? c.json(detail) : errorResponse(c, 404, "not_found", "Handoff not found.");
  });

  staff.post("/handoffs/:id/claim", async (c) => {
    const actor = await identity(c.req.header("authorization"));
    if (!actor) return errorResponse(c, 401, "unauthorized", "Staff token required.");
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return errorResponse(c, 404, "not_found", "Handoff not found.");
    const result = await claimHandoff(deps, actor.tenantId, id, actor.name);
    if (result === "not_found") return errorResponse(c, 404, "not_found", "Handoff not found.");
    if (result === "already_claimed") return errorResponse(c, 409, "conflict", "Handoff already claimed.");
    return c.json({ status: result });
  });

  staff.post("/handoffs/:id/reply", async (c) => {
    const actor = await identity(c.req.header("authorization"));
    if (!actor) return errorResponse(c, 401, "unauthorized", "Staff token required.");
    const body = ReplyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return errorResponse(c, 400, "invalid_input", "Reply text is required.");
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return errorResponse(c, 404, "not_found", "Handoff not found.");
    const result = await staffReply(deps, actor.tenantId, id, actor.name, body.data.text);
    if (result === "not_found") return errorResponse(c, 404, "not_found", "Handoff not found.");
    if (result === "not_claimed_by_you") {
      return errorResponse(c, 409, "conflict", "Claim this handoff before replying.");
    }
    return c.json({ status: result });
  });

  for (const [path, finish] of [
    ["hand-back", handBack],
    ["resolve", resolveHandoff],
  ] as const) {
    staff.post(`/handoffs/:id/${path}`, async (c) => {
      const actor = await identity(c.req.header("authorization"));
      if (!actor) return errorResponse(c, 401, "unauthorized", "Staff token required.");
      const id = c.req.param("id");
      if (!UUID.safeParse(id).success) return errorResponse(c, 404, "not_found", "Handoff not found.");
      const exists = await withTenant(deps.db, actor.tenantId, (tx) => getHandoff(tx, id));
      if (!exists) return errorResponse(c, 404, "not_found", "Handoff not found.");
      await finish(deps, actor.tenantId, id);
      return c.body(null, 204);
    });
  }
}
