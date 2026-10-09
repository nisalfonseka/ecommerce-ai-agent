import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgres"),
  ACE_MASTER_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  ADMIN_API_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest"),
  CONVERSATION_TOKEN_SECRET: z.string().min(32, "must be at least 32 characters"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface EngineConfig {
  databaseUrl: string;
  masterKey: Buffer;
  adminApiKeySha256: string;
  conversationTokenSecret: string;
  port: number;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  /** Proxies in front of the engine (Caddy = 1); used to read the client IP from X-Forwarded-For. */
  trustProxyHops: number;
  otlpEndpoint: string | undefined;
  /** The keyless demo model ("demo:*") is allowed only outside production. */
  allowDemoModel: boolean;
}

/** Validates the environment. Errors name the variable and the rule, never the value (it may be a secret). */
export function loadConfig(env: Record<string, string | undefined>): EngineConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid engine configuration: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    masterKey: Buffer.from(e.ACE_MASTER_KEY, "base64"),
    adminApiKeySha256: e.ADMIN_API_KEY_SHA256,
    conversationTokenSecret: e.CONVERSATION_TOKEN_SECRET,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
    allowDemoModel: e.NODE_ENV !== "production",
  };
}
