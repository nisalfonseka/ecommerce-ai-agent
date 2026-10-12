import { defineConfig, loadEnv } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const payhereEnabled = Boolean(process.env.PAYHERE_MERCHANT_ID && process.env.PAYHERE_MERCHANT_SECRET);

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: env("DATABASE_URL"),
    http: {
      storeCors: env("STORE_CORS", "http://localhost:8000"),
      adminCors: env("ADMIN_CORS", "http://localhost:9000"),
      authCors: env("AUTH_CORS", "http://localhost:9000"),
      jwtSecret: env("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "dev-jwt-secret"),
      cookieSecret: env(
        "COOKIE_SECRET",
        process.env.NODE_ENV === "production" ? undefined : "dev-cookie-secret",
      ),
    },
  },
  admin: { disable: process.env.MEDUSA_ADMIN !== "true" },
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: payhereEnabled
          ? [
              {
                resolve: "./src/modules/payhere",
                id: "payhere",
                options: {
                  merchantId: env("PAYHERE_MERCHANT_ID"),
                  merchantSecret: env("PAYHERE_MERCHANT_SECRET"),
                  sandbox: process.env.PAYHERE_SANDBOX !== "false",
                  storefrontUrl: env("STOREFRONT_URL", "http://localhost:8000"),
                  backendUrl: env("BACKEND_URL", "http://localhost:9000"),
                },
              },
            ]
          : [],
      },
    },
  ],
});
