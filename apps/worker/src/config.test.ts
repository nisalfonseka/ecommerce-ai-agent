import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://ace_app:secret-password@db:5432/ace",
  ACE_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
};

describe("loadWorkerConfig", () => {
  it("applies the defaults", () => {
    const config = loadWorkerConfig(valid);
    expect(config).toMatchObject({
      databaseUrl: valid.DATABASE_URL,
      logLevel: "info",
      concurrency: 4,
      reconcileCron: "*/15 * * * *",
      fullReconcileCron: "30 2 * * *",
      retentionCron: "0 3 * * *",
      allowDemoModels: true,
    });
    expect(config.masterKey).toHaveLength(32);
  });

  it("disallows demo models in production and reads overrides", () => {
    const config = loadWorkerConfig({
      ...valid,
      NODE_ENV: "production",
      WORKER_CONCURRENCY: "2",
      RECONCILE_CRON: "*/5 * * * *",
      LOG_LEVEL: "warn",
    });
    expect(config).toMatchObject({
      allowDemoModels: false,
      concurrency: 2,
      reconcileCron: "*/5 * * * *",
      logLevel: "warn",
    });
  });

  it("names a missing DATABASE_URL", () => {
    expect(() => loadWorkerConfig({ ACE_MASTER_KEY: valid.ACE_MASTER_KEY })).toThrow(/DATABASE_URL/);
  });

  it("names a bad variable without echoing its value", () => {
    try {
      loadWorkerConfig({ ...valid, ACE_MASTER_KEY: "too-short-secret-value" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/ACE_MASTER_KEY/);
      expect(String(error)).not.toContain("too-short-secret-value");
    }
    expect(() => loadWorkerConfig({ ...valid, WORKER_CONCURRENCY: "0" })).toThrow(/WORKER_CONCURRENCY/);
  });
});
