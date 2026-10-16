import { normalizeEmail, normalizePhone } from "@ace/contracts";
import { createPrivacyRequest, listPrivacyRequests, schema, takePrivacyExport, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import type { Hono } from "hono";
import { z } from "zod";
import type { WidgetEnv } from "../auth/widget";
import { errorResponse } from "../http-errors";
import { deriveKey, identityHash } from "../identity/hash";
import type { AdminDeps } from "./admin";

const PrivacySubjectBody = z
  .strictObject({
    email: z.string().optional(),
    phone: z.string().optional(),
    conversationId: z.uuid().optional(),
  })
  .refine(
    (value) =>
      Number(value.email !== undefined) +
        Number(value.phone !== undefined) +
        Number(value.conversationId !== undefined) ===
      1,
    "exactly one subject is required",
  );

type PrivacyDeps = Pick<AdminDeps, "db" | "jobs" | "masterKey">;

function subjectOf(
  tenantId: string,
  body: z.infer<typeof PrivacySubjectBody>,
  masterKey: Buffer,
): { receiptHash: string | null; job: { subjectHash: string } | { conversationId: string } } | null {
  if (body.conversationId) return { receiptHash: null, job: { conversationId: body.conversationId } };
  const kind = body.email !== undefined ? "email" : "phone";
  const normalized = kind === "email" ? normalizeEmail(body.email ?? "") : normalizePhone(body.phone ?? "");
  if (!normalized) return null;
  const key = deriveKey(masterKey, "ace/identity-hash/v1");
  const hash = identityHash(key, tenantId, kind, normalized);
  return { receiptHash: hash, job: { subjectHash: hash } };
}

/** Admin routes are mounted on the already-authenticated `/admin` sub-app. */
export function registerPrivacyAdminRoutes(admin: Hono<WidgetEnv>, deps: PrivacyDeps): void {
  const tenant = (value: string | undefined) => (z.uuid().safeParse(value).success ? (value ?? null) : null);
  const tenantExists = (tenantId: string) =>
    withTenant(
      deps.db,
      tenantId,
      async (tx) => (await tx.select({ id: schema.tenants.id }).from(schema.tenants).limit(1)).length === 1,
    );

  for (const type of ["export", "delete"] as const) {
    admin.post(`/tenants/:tenantId/privacy/${type}`, async (c) => {
      const tenantId = tenant(c.req.param("tenantId"));
      const body = PrivacySubjectBody.safeParse(await c.req.json().catch(() => null));
      if (!tenantId || !(await tenantExists(tenantId)))
        return errorResponse(c, 404, "not_found", "Unknown tenant.");
      if (!body.success)
        return errorResponse(
          c,
          400,
          "invalid_input",
          "Provide exactly one valid email, phone or conversationId.",
        );
      const subject = subjectOf(tenantId, body.data, deps.masterKey);
      if (!subject)
        return errorResponse(
          c,
          400,
          "invalid_input",
          "Provide exactly one valid email, phone or conversationId.",
        );
      const request = await withTenant(deps.db, tenantId, (tx) =>
        createPrivacyRequest(tx, tenantId, { type, subjectHash: subject.receiptHash }),
      );
      const job = type === "export" ? JOBS.shopperExport : JOBS.shopperDelete;
      await deps.jobs.send(job, { tenantId, requestId: request.id, ...subject.job });
      return c.json({ requestId: request.id }, 202);
    });
  }

  admin.post("/tenants/:tenantId/privacy/offboard", async (c) => {
    const tenantId = tenant(c.req.param("tenantId"));
    if (!tenantId || !(await tenantExists(tenantId)))
      return errorResponse(c, 404, "not_found", "Unknown tenant.");
    const request = await withTenant(deps.db, tenantId, (tx) =>
      createPrivacyRequest(tx, tenantId, { type: "offboard", subjectHash: null }),
    );
    await deps.jobs.send(JOBS.tenantOffboard, { tenantId, requestId: request.id });
    return c.json({ requestId: request.id }, 202);
  });

  admin.get("/tenants/:tenantId/privacy/requests", async (c) => {
    const tenantId = tenant(c.req.param("tenantId"));
    if (!tenantId || !(await tenantExists(tenantId)))
      return errorResponse(c, 404, "not_found", "Unknown tenant.");
    const rows = await withTenant(deps.db, tenantId, (tx) => listPrivacyRequests(tx));
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        counts: row.counts,
        requestedAt: row.createdAt,
        completedAt: row.completedAt,
      })),
    });
  });

  admin.get("/tenants/:tenantId/privacy/requests/:requestId/download", async (c) => {
    const tenantId = tenant(c.req.param("tenantId"));
    const requestId = c.req.param("requestId");
    if (!tenantId || !z.uuid().safeParse(requestId).success || !(await tenantExists(tenantId))) {
      return errorResponse(c, 404, "not_found", "Export not found.");
    }
    const payload = await withTenant(deps.db, tenantId, (tx) => takePrivacyExport(tx, requestId));
    if (payload === null) return errorResponse(c, 404, "not_found", "Export not found.");
    return new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "content-disposition": `attachment; filename="privacy-export-${requestId}.json"`,
        "cache-control": "no-store",
      },
    });
  });
}
