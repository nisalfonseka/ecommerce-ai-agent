import { Hono } from "hono";
import type { Logger } from "pino";
import { type ResolveWidgetKey, type WidgetEnv, widgetAuth } from "./auth/widget";
import { errorResponse } from "./http-errors";

export interface AppDeps {
  logger: Logger;
  /** true when the database answers. */
  ping: () => Promise<boolean>;
  resolveWidgetKey: ResolveWidgetKey;
}

/** The HTTP surface. Routes are added by later tasks; everything under /v1 requires a widget key. */
export function createApp(deps: AppDeps): Hono<WidgetEnv> {
  const app = new Hono<WidgetEnv>();

  app.onError((error, c) => {
    deps.logger.error({ err: error, path: c.req.path }, "unhandled error");
    return errorResponse(c, 500, "internal", "Something went wrong. Please try again.");
  });
  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found."));

  app.get("/healthz", async (c) => {
    const ok = await deps.ping();
    return c.json({ ok }, ok ? 200 : 503);
  });

  app.use("/v1/*", widgetAuth({ resolveWidgetKey: deps.resolveWidgetKey }));
  return app;
}
