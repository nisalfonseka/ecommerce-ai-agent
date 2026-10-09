# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Create the monorepo, the universal commerce contract (`@ace/contracts`), an adapter conformance test suite, and an in-memory clothing-store adapter (`@ace/adapter-memory`) that passes it.

**Architecture:** `@ace/contracts` holds Zod schemas, TypeScript types, the `CommerceProvider` interface, typed `CommerceError`s and capability flags. It has no runtime dependency besides Zod. `@ace/contracts/testing` exports `describeProviderConformance`, a Vitest suite every adapter must pass. `@ace/adapter-memory` implements the contract over a seeded LKR clothing catalog. It is the test double for the agent (Phase 2) and the evals.

**Tech Stack:** Node.js ≥ 22 (24 LTS), pnpm workspaces, Turborepo, TypeScript (strict), Zod v4, Vitest, Biome.

**Spec:** [`docs/superpowers/specs/2026-10-08-ai-commerce-engine-design.md`](../specs/2026-10-08-ai-commerce-engine-design.md) (§3.2 J1, §4.2). Repo rules: [`AGENTS.md`](../../../AGENTS.md).

## Global Constraints

- Node.js ≥ 22; `.nvmrc` = `24`. ESM only (`"type": "module"` in every `package.json`).
- TypeScript `strict` + `noUncheckedIndexedAccess`. No `any`, no non-null assertions (`!`).
- Package scope `@ace/*`. Internal packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`); there is no build step in Phase 1.
- `@ace/contracts` runtime dependencies: **only `zod` (v4)**. `vitest` is an optional peer, used only by `@ace/contracts/testing`.
- Money is `{ amount: integer minor units, currency: ISO 4217 uppercase }`. LKR 6,500.00 → `{ amount: 650000, currency: "LKR" }`. No floats anywhere.
- Every expected failure is a `CommerceError` with a code from `COMMERCE_ERROR_CODES`. Adapters validate every input with `parseInput(schema, value)`.
- IDs are opaque strings. Never parse or construct another system's IDs.
- Tests live next to source as `*.test.ts` and run with Vitest.
- Formatting: Biome, 2-space indent, double quotes, line width 110. Run `pnpm lint:fix` before each commit.

## Review Focus

1. **Stock and quantity edges in carts:** asking for more than is in stock, merging lines past the 20-unit cap, or a multi-line add where one line fails → typed error and **no partial change** to the cart. (Tests in Task 8.)
2. **Retried writes:** the agent retries `addCartLines` with the same idempotency key after a timeout → no double add. The same key on a different cart is independent. (Tests in Task 8.)
3. **Order lookup by the wrong person:** a stranger's identity, a differently-cased order number, or a phone-only identity → `null` for strangers (indistinguishable from "not found"), the order for the owner. (Tests in Task 7.)
4. **Currency mistakes:** fractional amounts, lowercase codes, adding different currencies, or creating a cart in a currency the store does not sell → `INVALID_INPUT`. (Tests in Tasks 1 and 8.)
5. **Tampered pagination cursors:** a garbage or hand-edited cursor → `INVALID_INPUT`, not a crash and not silently page 1. (Tests in Task 6.)

---

## File Structure

```text
.
├── .github/workflows/ci.yml                 # Task 9: lint + typecheck + test
├── .gitignore  .nvmrc  biome.json            # Task 1
├── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json   # Task 1
├── docs/adr/001-commerce-contract.md         # Task 4
└── packages/
    ├── contracts/
    │   ├── package.json  tsconfig.json       # Task 1
    │   └── src/
    │       ├── errors.ts        (+ .test.ts) # Task 1: CommerceError, parseInput
    │       ├── money.ts         (+ .test.ts) # Task 1: Money schema + arithmetic
    │       ├── catalog.ts       (+ .test.ts) # Task 2: Product, Variant, search/list inputs, summarizeProduct
    │       ├── inventory.ts                  # Task 2: InventoryLevel
    │       ├── test-fixtures.ts              # Task 2: sampleProduct/sampleVariant (tests only, not exported)
    │       ├── cart.ts          (+ .test.ts) # Task 3: Cart, cart inputs, WriteOptions
    │       ├── checkout.ts                   # Task 3: CheckoutHandoff
    │       ├── identity.ts      (+ .test.ts) # Task 3: VerifiedIdentity, identityMatches
    │       ├── orders.ts                     # Task 3: Order, lookup/list inputs
    │       ├── capabilities.ts  (+ .test.ts) # Task 4: Capability, requireCapability
    │       ├── provider.ts                   # Task 4: CommerceProvider interface
    │       ├── index.ts                      # Task 4: public exports
    │       └── testing/
    │           ├── fixtures.ts               # Task 5: ConformanceFixtures type (no vitest import)
    │           ├── conformance.ts            # Task 5: describeProviderConformance
    │           ├── conformance.self.test.ts  # Task 5
    │           └── index.ts                  # Task 5
    └── adapter-memory/
        ├── package.json  tsconfig.json       # Task 6
        └── src/
            ├── seed.ts                       # Task 6: LKR clothing catalog, stock, orders, fixtures
            ├── cursor.ts        (+ .test.ts) # Task 6: opaque offset cursors
            ├── search.ts        (+ .test.ts) # Task 6: searchCatalog
            ├── memory-provider.ts (+ .test.ts) # Tasks 7–8
            ├── conformance.test.ts           # Task 8
            └── index.ts                      # Task 7
```

---

### Task 1: Workspace scaffold, `CommerceError`, and `Money`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/errors.ts`, `packages/contracts/src/money.ts`
- Test: `packages/contracts/src/errors.test.ts`, `packages/contracts/src/money.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COMMERCE_ERROR_CODES`, `type CommerceErrorCode`, `class CommerceError(code, message, details?)` with `.code`, `.retryable`, `.details`
  - `isCommerceError(e: unknown): e is CommerceError`
  - `parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S>` (throws `CommerceError("INVALID_INPUT")`)
  - `CurrencyCodeSchema`, `MoneySchema`, `type Money`, `money(amount, currency)`, `addMoney(a, b)`, `multiplyMoney(m, factor)`

- [x] **Step 1: Initialise git and root files**

```bash
git init
```

`package.json`:

```json
{
  "name": "ai-commerce-engine",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "test": { "dependsOn": ["^typecheck"] },
    "typecheck": { "dependsOn": ["^typecheck"] }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`biome.json`:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double" } }
}
```

`.gitignore`:

```gitignore
node_modules/
dist/
.turbo/
coverage/
.env
.env.*
!.env.example
.DS_Store
```

`.nvmrc`:

```text
24
```

- [x] **Step 2: Pin pnpm and install root tooling**

```bash
corepack enable
corepack use pnpm@latest
pnpm add -Dw turbo typescript vitest @biomejs/biome @types/node
```

Expected: `package.json` gains `"packageManager": "pnpm@…"` and the five devDependencies; `pnpm-lock.yaml` is created.

- [x] **Step 3: Create the contracts package shell**

`packages/contracts/package.json`:

```json
{
  "name": "@ace/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": { "vitest": "*" },
  "peerDependenciesMeta": { "vitest": { "optional": true } }
}
```

`packages/contracts/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm --filter @ace/contracts add zod@^4
pnpm --filter @ace/contracts add -D vitest typescript
```

- [x] **Step 4: Write the failing tests**

`packages/contracts/src/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CommerceError, isCommerceError, parseInput } from "./errors";

describe("CommerceError", () => {
  it("marks only transient failures as retryable", () => {
    expect(new CommerceError("RATE_LIMITED", "slow down").retryable).toBe(true);
    expect(new CommerceError("UPSTREAM_UNAVAILABLE", "down").retryable).toBe(true);
    expect(new CommerceError("OUT_OF_STOCK", "gone").retryable).toBe(false);
    expect(new CommerceError("INVALID_INPUT", "bad").retryable).toBe(false);
  });

  it("keeps code, message and details", () => {
    const error = new CommerceError("NOT_FOUND", "no cart", { cartId: "c1" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CommerceError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("no cart");
    expect(error.details).toEqual({ cartId: "c1" });
  });

  it("is recognised by isCommerceError", () => {
    expect(isCommerceError(new CommerceError("CONFLICT", "x"))).toBe(true);
    expect(isCommerceError(new Error("x"))).toBe(false);
    expect(isCommerceError("x")).toBe(false);
  });
});

describe("parseInput", () => {
  const schema = z.object({ quantity: z.number().int().min(1) });

  it("returns parsed data for valid input", () => {
    expect(parseInput(schema, { quantity: 2 })).toEqual({ quantity: 2 });
  });

  it("throws INVALID_INPUT with zod issues for invalid input", () => {
    try {
      parseInput(schema, { quantity: 0 });
      expect.unreachable("parseInput should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError);
      expect((error as CommerceError).code).toBe("INVALID_INPUT");
      expect((error as CommerceError).details?.issues).toBeInstanceOf(Array);
    }
  });
});
```

`packages/contracts/src/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CommerceError } from "./errors";
import { addMoney, money, multiplyMoney } from "./money";

describe("money", () => {
  it("stores integer minor units", () => {
    expect(money(650000, "LKR")).toEqual({ amount: 650000, currency: "LKR" });
  });

  it("rejects fractional amounts", () => {
    expect(() => money(12.5, "LKR")).toThrow(CommerceError);
  });

  it("rejects currency codes that are not 3 uppercase letters", () => {
    expect(() => money(100, "rs")).toThrow(CommerceError);
    expect(() => money(100, "lkr")).toThrow(CommerceError);
  });

  it("adds same-currency amounts", () => {
    expect(addMoney(money(100, "LKR"), money(250, "LKR"))).toEqual(money(350, "LKR"));
  });

  it("refuses to add different currencies", () => {
    expect(() => addMoney(money(100, "LKR"), money(1, "USD"))).toThrow(CommerceError);
  });

  it("multiplies by integer factors only", () => {
    expect(multiplyMoney(money(700, "LKR"), 3)).toEqual(money(2100, "LKR"));
    expect(() => multiplyMoney(money(700, "LKR"), 1.5)).toThrow(CommerceError);
  });
});
```

- [x] **Step 5: Run tests to verify they fail**

Run: `pnpm --filter @ace/contracts test`
Expected: FAIL with "Failed to resolve import "./errors"" (and "./money").

- [x] **Step 6: Implement `errors.ts` and `money.ts`**

`packages/contracts/src/errors.ts`:

```ts
import { z } from "zod";

export const COMMERCE_ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_INPUT",
  "OUT_OF_STOCK",
  "NOT_SUPPORTED",
  "UNAUTHORIZED",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<CommerceErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

/** The only error type adapters may throw for expected failures. Platform errors must be translated. */
export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CommerceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.details = details;
  }
}

export function isCommerceError(error: unknown): error is CommerceError {
  return error instanceof CommerceError;
}

/** Validates untrusted input; throws CommerceError("INVALID_INPUT") with the zod issues. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CommerceError("INVALID_INPUT", z.prettifyError(result.error), { issues: result.error.issues });
  }
  return result.data;
}
```

`packages/contracts/src/money.ts`:

```ts
import { z } from "zod";
import { CommerceError, parseInput } from "./errors";

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. LKR");

/** Integer amount in the currency's minor unit (LKR 1,250.00 → 125000). Never floats. */
export const MoneySchema = z.object({
  amount: z.number().int(),
  currency: CurrencyCodeSchema,
});

export type Money = z.infer<typeof MoneySchema>;

export function money(amount: number, currency: string): Money {
  return parseInput(MoneySchema, { amount, currency });
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CommerceError("INVALID_INPUT", `Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function multiplyMoney(value: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new CommerceError("INVALID_INPUT", "Money can only be multiplied by an integer");
  }
  return { amount: value.amount * factor, currency: value.currency };
}
```

- [x] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @ace/contracts test`
Expected: PASS — 2 files, 11 tests.

- [x] **Step 8: Run lint and typecheck**

Run: `pnpm lint:fix && pnpm lint && pnpm typecheck`
Expected: no errors.

- [x] **Step 9: Commit**

```bash
git add .
git commit -m "chore: scaffold monorepo; feat(contracts): add CommerceError, parseInput and Money"
```

---

### Task 2: Catalog and inventory schemas

**Files:**
- Create: `packages/contracts/src/catalog.ts`, `packages/contracts/src/inventory.ts`, `packages/contracts/src/test-fixtures.ts`
- Test: `packages/contracts/src/catalog.test.ts`

**Interfaces:**
- Consumes: `MoneySchema` (Task 1), `parseInput` (Task 1).
- Produces:
  - `AvailabilitySchema`, `type Availability` = `"in_stock" | "low_stock" | "out_of_stock" | "backorder"`
  - `ImageSchema`/`Image`, `VariantSchema`/`Variant`, `ProductSchema`/`Product`, `ProductSummarySchema`/`ProductSummary`
  - `SearchProductsInputSchema`, `type SearchProductsInput` (z.input), `type SearchFilters` (parsed filters)
  - `SearchProductsResultSchema`/`SearchProductsResult` = `{ items: ProductSummary[]; nextCursor: string | null }`
  - `ListProductsInputSchema`, `type ListProductsInput`, `ListProductsResultSchema`/`ListProductsResult` = `{ items: Product[]; nextCursor: string | null }`
  - `aggregateAvailability(values: Availability[]): Availability`
  - `summarizeProduct(product: Product, matchingVariantIds?: string[]): ProductSummary`
  - `InventoryLevelSchema`/`InventoryLevel` = `{ variantId; availability; quantityAvailable: number | null }`, `GetInventoryInputSchema` (1–100 IDs)
  - Test-only: `sampleVariant(overrides?)`, `sampleProduct(overrides?)` from `src/test-fixtures.ts`

- [x] **Step 1: Write the test fixtures**

`packages/contracts/src/test-fixtures.ts`:

```ts
import type { Product, Variant } from "./catalog";

/** Test-only builders. Not exported from the package index. */
export function sampleVariant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "var_dress_m",
    productId: "prod_dress",
    sku: "DRESS-M",
    title: "Black / M",
    options: { color: "Black", size: "M" },
    price: { amount: 1850000, currency: "LKR" },
    availability: "in_stock",
    ...overrides,
  };
}

export function sampleProduct(overrides: Partial<Product> = {}): Product {
  const variant = sampleVariant();
  return {
    id: "prod_dress",
    handle: "black-wrap-dress",
    title: "Black Satin Wrap Dress",
    description: "A satin wrap dress for evening events.",
    url: "https://demo-store.test/products/black-wrap-dress",
    category: "dress",
    tags: ["women"],
    attributes: { color: ["black"], occasion: ["wedding", "party"] },
    images: [{ url: "https://demo-store.test/images/dress.jpg", alt: "Black Satin Wrap Dress" }],
    options: [
      { name: "color", values: ["Black"] },
      { name: "size", values: ["M"] },
    ],
    variants: [variant],
    priceRange: { min: variant.price, max: variant.price },
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}
```

- [x] **Step 2: Write the failing tests**

`packages/contracts/src/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateAvailability,
  ListProductsInputSchema,
  ProductSchema,
  SearchProductsInputSchema,
  summarizeProduct,
} from "./catalog";
import { InventoryLevelSchema } from "./inventory";
import { sampleProduct, sampleVariant } from "./test-fixtures";

describe("ProductSchema", () => {
  it("accepts a well-formed product", () => {
    expect(ProductSchema.parse(sampleProduct())).toEqual(sampleProduct());
  });

  it("rejects a product without variants", () => {
    expect(ProductSchema.safeParse(sampleProduct({ variants: [] })).success).toBe(false);
  });

  it("rejects fractional prices", () => {
    const variant = sampleVariant({ price: { amount: 10.5, currency: "LKR" } });
    expect(ProductSchema.safeParse(sampleProduct({ variants: [variant] })).success).toBe(false);
  });
});

describe("SearchProductsInputSchema", () => {
  it("applies defaults", () => {
    expect(SearchProductsInputSchema.parse({})).toEqual({ filters: {}, limit: 10 });
  });

  it("trims the query", () => {
    expect(SearchProductsInputSchema.parse({ query: "  black dress " }).query).toBe("black dress");
  });

  it("caps the page size at 50", () => {
    expect(SearchProductsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it("rejects priceMin greater than priceMax", () => {
    const result = SearchProductsInputSchema.safeParse({ filters: { priceMin: 5000, priceMax: 100 } });
    expect(result.success).toBe(false);
  });

  it("rejects negative and fractional price filters", () => {
    expect(SearchProductsInputSchema.safeParse({ filters: { priceMax: -1 } }).success).toBe(false);
    expect(SearchProductsInputSchema.safeParse({ filters: { priceMax: 10.5 } }).success).toBe(false);
  });
});

describe("ListProductsInputSchema", () => {
  it("defaults to 100 and caps at 250", () => {
    expect(ListProductsInputSchema.parse({}).limit).toBe(100);
    expect(ListProductsInputSchema.safeParse({ limit: 251 }).success).toBe(false);
  });
});

describe("aggregateAvailability", () => {
  it("returns the best availability across variants", () => {
    expect(aggregateAvailability(["out_of_stock", "low_stock"])).toBe("low_stock");
    expect(aggregateAvailability(["low_stock", "in_stock"])).toBe("in_stock");
    expect(aggregateAvailability(["out_of_stock", "backorder"])).toBe("backorder");
    expect(aggregateAvailability([])).toBe("out_of_stock");
  });
});

describe("summarizeProduct", () => {
  it("summarises with all variants matching by default", () => {
    const summary = summarizeProduct(sampleProduct());
    expect(summary).toMatchObject({
      id: "prod_dress",
      title: "Black Satin Wrap Dress",
      availability: "in_stock",
      matchingVariantIds: ["var_dress_m"],
      image: { url: "https://demo-store.test/images/dress.jpg" },
    });
  });
});

describe("InventoryLevelSchema", () => {
  it("allows hidden quantities as null", () => {
    const level = { variantId: "v1", availability: "in_stock", quantityAvailable: null };
    expect(InventoryLevelSchema.parse(level)).toEqual(level);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @ace/contracts test`
Expected: FAIL with "Failed to resolve import "./catalog"".

- [x] **Step 4: Implement `catalog.ts` and `inventory.ts`**

`packages/contracts/src/catalog.ts`:

```ts
import { z } from "zod";
import { MoneySchema } from "./money";

export const AvailabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock", "backorder"]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const ImageSchema = z.object({ url: z.url(), alt: z.string().optional() });
export type Image = z.infer<typeof ImageSchema>;

export const VariantSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  sku: z.string().optional(),
  /** Human label, e.g. "Black / M". */
  title: z.string().min(1),
  /** Option name → value, e.g. { color: "Black", size: "M" }. */
  options: z.record(z.string(), z.string()),
  price: MoneySchema,
  compareAtPrice: MoneySchema.optional(),
  availability: AvailabilitySchema,
});
export type Variant = z.infer<typeof VariantSchema>;

const PriceRangeSchema = z.object({ min: MoneySchema, max: MoneySchema });

export const ProductSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  url: z.url().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()),
  /** Normalised attributes for filtering, e.g. { color: ["black"], occasion: ["wedding"] }. */
  attributes: z.record(z.string(), z.array(z.string())),
  images: z.array(ImageSchema),
  options: z.array(z.object({ name: z.string().min(1), values: z.array(z.string()).min(1) })),
  variants: z.array(VariantSchema).min(1),
  priceRange: PriceRangeSchema,
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export const ProductSummarySchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  url: z.url().optional(),
  image: ImageSchema.optional(),
  priceRange: PriceRangeSchema,
  availability: AvailabilitySchema,
  /** Variants that satisfied the search filters. */
  matchingVariantIds: z.array(z.string()),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const SearchProductsInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  filters: z
    .object({
      category: z.string().optional(),
      /** Option name → accepted values (any-of), e.g. { size: ["M", "L"] }. */
      options: z.record(z.string(), z.array(z.string()).min(1)).optional(),
      /** Minor units, in the store currency. Inclusive. */
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      inStockOnly: z.boolean().optional(),
    })
    .refine((f) => f.priceMin === undefined || f.priceMax === undefined || f.priceMin <= f.priceMax, {
      message: "priceMin must be <= priceMax",
    })
    .default({}),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});
export type SearchProductsInput = z.input<typeof SearchProductsInputSchema>;
export type SearchFilters = z.output<typeof SearchProductsInputSchema>["filters"];

export const SearchProductsResultSchema = z.object({
  items: z.array(ProductSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SearchProductsResult = z.infer<typeof SearchProductsResultSchema>;

export const ListProductsInputSchema = z.object({
  /** Inclusive lower bound on Product.updatedAt. */
  updatedSince: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(250).default(100),
  cursor: z.string().optional(),
});
export type ListProductsInput = z.input<typeof ListProductsInputSchema>;

export const ListProductsResultSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
});
export type ListProductsResult = z.infer<typeof ListProductsResultSchema>;

const AVAILABILITY_RANK: readonly Availability[] = ["in_stock", "low_stock", "backorder", "out_of_stock"];

/** Best availability across variants; out_of_stock for an empty list. */
export function aggregateAvailability(values: Availability[]): Availability {
  for (const candidate of AVAILABILITY_RANK) {
    if (values.includes(candidate)) return candidate;
  }
  return "out_of_stock";
}

export function summarizeProduct(
  product: Product,
  matchingVariantIds: string[] = product.variants.map((variant) => variant.id),
): ProductSummary {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    url: product.url,
    image: product.images[0],
    priceRange: product.priceRange,
    availability: aggregateAvailability(product.variants.map((variant) => variant.availability)),
    matchingVariantIds,
  };
}
```

`packages/contracts/src/inventory.ts`:

```ts
import { z } from "zod";
import { AvailabilitySchema } from "./catalog";

export const InventoryLevelSchema = z.object({
  variantId: z.string().min(1),
  availability: AvailabilitySchema,
  /** null when the platform does not expose exact counts. */
  quantityAvailable: z.number().int().nonnegative().nullable(),
});
export type InventoryLevel = z.infer<typeof InventoryLevelSchema>;

export const GetInventoryInputSchema = z.array(z.string().min(1)).min(1).max(100);
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ace/contracts test`
Expected: PASS — 3 files, 23 tests.

- [x] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add packages/contracts
git commit -m "feat(contracts): add catalog and inventory schemas"
```

---

### Task 3: Cart, checkout, identity and order schemas

**Files:**
- Create: `packages/contracts/src/cart.ts`, `packages/contracts/src/checkout.ts`, `packages/contracts/src/identity.ts`, `packages/contracts/src/orders.ts`
- Test: `packages/contracts/src/cart.test.ts`, `packages/contracts/src/identity.test.ts`

**Interfaces:**
- Consumes: `MoneySchema`, `CurrencyCodeSchema` (Task 1); `ImageSchema` (Task 2).
- Produces:
  - `MAX_LINE_QUANTITY = 20`, `ATTRIBUTION_ATTRIBUTE = "ace_conversation_id"`
  - `CartLineSchema`/`CartLine`, `CartSchema`/`Cart` = `{ id; currency; lines; subtotal; itemCount; attributes: Record<string,string>; updatedAt }`
  - `CreateCartInputSchema`/`CreateCartInput` (z.input: `{ currency?; attributes? }`)
  - `AddCartLinesInputSchema`/`AddCartLinesInput` = `{ lines: { variantId; quantity }[] }`
  - `UpdateCartLineInputSchema`/`UpdateCartLineInput` = `{ lineId; quantity }` (0 removes)
  - `WriteOptionsSchema`/`WriteOptions` = `{ idempotencyKey: string (8–128 chars) }`
  - `CheckoutHandoffSchema`/`CheckoutHandoff` = `{ cartId; url; expiresAt: string | null }`
  - `VerifiedIdentitySchema`/`VerifiedIdentity`, `type OrderOwner`, `identityMatches(identity, owner): boolean`
  - `OrderSchema`/`Order`, `LookupOrderInputSchema`/`LookupOrderInput`, `ListOrdersInputSchema`/`ListOrdersInput`

- [x] **Step 1: Write the failing tests**

`packages/contracts/src/cart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AddCartLinesInputSchema,
  CreateCartInputSchema,
  MAX_LINE_QUANTITY,
  UpdateCartLineInputSchema,
  WriteOptionsSchema,
} from "./cart";

describe("cart inputs", () => {
  it("accepts quantities from 1 to MAX_LINE_QUANTITY when adding", () => {
    expect(AddCartLinesInputSchema.safeParse({ lines: [{ variantId: "v", quantity: 1 }] }).success).toBe(true);
    const max = { lines: [{ variantId: "v", quantity: MAX_LINE_QUANTITY }] };
    expect(AddCartLinesInputSchema.safeParse(max).success).toBe(true);
  });

  it("rejects zero, negative, fractional and oversized quantities when adding", () => {
    for (const quantity of [0, -1, 1.5, MAX_LINE_QUANTITY + 1]) {
      const result = AddCartLinesInputSchema.safeParse({ lines: [{ variantId: "v", quantity }] });
      expect(result.success, `quantity ${quantity}`).toBe(false);
    }
  });

  it("rejects an empty line list", () => {
    expect(AddCartLinesInputSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it("allows quantity 0 on update (removes the line)", () => {
    expect(UpdateCartLineInputSchema.parse({ lineId: "l1", quantity: 0 })).toEqual({ lineId: "l1", quantity: 0 });
  });

  it("defaults cart attributes to an empty object and caps value length", () => {
    expect(CreateCartInputSchema.parse({})).toEqual({ attributes: {} });
    const long = { attributes: { note: "x".repeat(256) } };
    expect(CreateCartInputSchema.safeParse(long).success).toBe(false);
  });

  it("requires an idempotency key of at least 8 characters", () => {
    expect(WriteOptionsSchema.safeParse({ idempotencyKey: "short" }).success).toBe(false);
    expect(WriteOptionsSchema.safeParse({ idempotencyKey: "turn-1:call-1" }).success).toBe(true);
  });
});
```

`packages/contracts/src/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { identityMatches, VerifiedIdentitySchema } from "./identity";
import { LookupOrderInputSchema } from "./orders";

const verifiedAt = "2026-10-01T00:00:00.000Z";

describe("VerifiedIdentitySchema", () => {
  it("requires at least one identifier", () => {
    expect(VerifiedIdentitySchema.safeParse({ method: "email_otp", verifiedAt }).success).toBe(false);
  });

  it("requires E.164 phone numbers", () => {
    const local = { method: "phone_otp", phone: "0771234567", verifiedAt };
    const e164 = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse(local).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse(e164).success).toBe(true);
  });
});

describe("identityMatches", () => {
  const owner = { email: "Customer@Example.com", phone: "+94771234567" };

  it("matches email case-insensitively", () => {
    expect(identityMatches({ method: "email_otp", email: "customer@example.com", verifiedAt }, owner)).toBe(true);
  });

  it("matches by phone", () => {
    expect(identityMatches({ method: "phone_otp", phone: "+94771234567", verifiedAt }, owner)).toBe(true);
  });

  it("does not match a different person", () => {
    expect(identityMatches({ method: "email_otp", email: "someone@example.com", verifiedAt }, owner)).toBe(false);
  });

  it("does not match when the owner lacks the identifier type", () => {
    const identity = { method: "host_session" as const, externalCustomerId: "cus_1", verifiedAt };
    expect(identityMatches(identity, owner)).toBe(false);
  });
});

describe("LookupOrderInputSchema", () => {
  it("trims the order number", () => {
    const parsed = LookupOrderInputSchema.parse({
      orderNumber: "  ACE-1001 ",
      identity: { method: "email_otp", email: "a@example.com", verifiedAt },
    });
    expect(parsed.orderNumber).toBe("ACE-1001");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ace/contracts test`
Expected: FAIL with "Failed to resolve import "./cart"" and "./identity".

- [x] **Step 3: Implement the four modules**

`packages/contracts/src/cart.ts`:

```ts
import { z } from "zod";
import { ImageSchema } from "./catalog";
import { CurrencyCodeSchema, MoneySchema } from "./money";

export const MAX_LINE_QUANTITY = 20;

/** Cart attribute that ties a cart (and the resulting order) to the ACE conversation. */
export const ATTRIBUTION_ATTRIBUTE = "ace_conversation_id";

export const CartLineSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  title: z.string(),
  variantTitle: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: MoneySchema,
  lineTotal: MoneySchema,
  image: ImageSchema.optional(),
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const CartSchema = z.object({
  id: z.string().min(1),
  currency: CurrencyCodeSchema,
  lines: z.array(CartLineSchema),
  subtotal: MoneySchema,
  itemCount: z.number().int().nonnegative(),
  attributes: z.record(z.string(), z.string()),
  updatedAt: z.iso.datetime(),
});
export type Cart = z.infer<typeof CartSchema>;

export const CreateCartInputSchema = z.object({
  currency: CurrencyCodeSchema.optional(),
  attributes: z.record(z.string().max(64), z.string().max(255)).default({}),
});
export type CreateCartInput = z.input<typeof CreateCartInputSchema>;

export const AddCartLinesInputSchema = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .min(1)
    .max(20),
});
export type AddCartLinesInput = z.input<typeof AddCartLinesInputSchema>;

export const UpdateCartLineInputSchema = z.object({
  lineId: z.string().min(1),
  /** 0 removes the line. */
  quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
});
export type UpdateCartLineInput = z.input<typeof UpdateCartLineInputSchema>;

export const WriteOptionsSchema = z.object({
  /** Same key + same operation + same target ⇒ the first result is returned again. */
  idempotencyKey: z.string().min(8).max(128),
});
export type WriteOptions = z.infer<typeof WriteOptionsSchema>;
```

`packages/contracts/src/checkout.ts`:

```ts
import { z } from "zod";

/** The shopper finishes payment on the store's own checkout page at `url`. */
export const CheckoutHandoffSchema = z.object({
  cartId: z.string().min(1),
  url: z.url(),
  expiresAt: z.iso.datetime().nullable(),
});
export type CheckoutHandoff = z.infer<typeof CheckoutHandoffSchema>;
```

`packages/contracts/src/identity.ts`:

```ts
import { z } from "zod";

/**
 * A shopper identity proven by the engine (host-site session token or OTP).
 * Built server-side only — never from model output.
 */
export const VerifiedIdentitySchema = z
  .object({
    method: z.enum(["host_session", "email_otp", "phone_otp"]),
    email: z.email().optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, "E.164 phone, e.g. +94771234567")
      .optional(),
    externalCustomerId: z.string().min(1).optional(),
    verifiedAt: z.iso.datetime(),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined || v.externalCustomerId !== undefined, {
    message: "identity needs an email, phone or externalCustomerId",
  });
export type VerifiedIdentity = z.infer<typeof VerifiedIdentitySchema>;

export interface OrderOwner {
  email?: string | undefined;
  phone?: string | undefined;
  externalCustomerId?: string | undefined;
}

export function identityMatches(identity: VerifiedIdentity, owner: OrderOwner): boolean {
  if (identity.email && owner.email && identity.email.toLowerCase() === owner.email.toLowerCase()) return true;
  if (identity.phone && owner.phone && identity.phone === owner.phone) return true;
  if (
    identity.externalCustomerId &&
    owner.externalCustomerId &&
    identity.externalCustomerId === owner.externalCustomerId
  ) {
    return true;
  }
  return false;
}
```

`packages/contracts/src/orders.ts`:

```ts
import { z } from "zod";
import { VerifiedIdentitySchema } from "./identity";
import { MoneySchema } from "./money";

export const OrderStatusSchema = z.enum([
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
]);

export const PaymentStatusSchema = z.enum(["pending", "paid", "cod_pending", "refunded", "failed"]);

/** Deliberately excludes addresses and payment details (data minimisation). */
export const OrderSchema = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  status: OrderStatusSchema,
  paymentStatus: PaymentStatusSchema,
  placedAt: z.iso.datetime(),
  total: MoneySchema,
  lines: z
    .array(
      z.object({
        title: z.string(),
        variantTitle: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: MoneySchema,
      }),
    )
    .min(1),
  tracking: z.array(z.object({ carrier: z.string(), number: z.string(), url: z.url().optional() })),
});
export type Order = z.infer<typeof OrderSchema>;

export const LookupOrderInputSchema = z.object({
  orderNumber: z.string().trim().min(1).max(64),
  identity: VerifiedIdentitySchema,
});
export type LookupOrderInput = z.input<typeof LookupOrderInputSchema>;

export const ListOrdersInputSchema = z.object({
  identity: VerifiedIdentitySchema,
  limit: z.number().int().min(1).max(20).default(5),
});
export type ListOrdersInput = z.input<typeof ListOrdersInputSchema>;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ace/contracts test`
Expected: PASS — 5 files, 36 tests.

- [x] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add packages/contracts
git commit -m "feat(contracts): add cart, checkout, identity and order schemas"
```

---

### Task 4: Capabilities, the `CommerceProvider` interface, public exports, ADR-001

**Files:**
- Create: `packages/contracts/src/capabilities.ts`, `packages/contracts/src/provider.ts`, `packages/contracts/src/index.ts`, `docs/adr/001-commerce-contract.md`
- Test: `packages/contracts/src/capabilities.test.ts`

**Interfaces:**
- Consumes: every type from Tasks 1–3.
- Produces:
  - `CAPABILITIES` = `["catalog.search","catalog.read","catalog.list","inventory.read","cart.write","checkout.handoff","orders.lookup"]`, `type Capability`
  - `requireCapability(provider: { platform: string; capabilities: ReadonlySet<Capability> }, capability: Capability): void`
  - `interface CommerceProvider` (exact signatures below)
  - `@ace/contracts` index re-exporting all public modules (not `test-fixtures`)

- [x] **Step 1: Write the failing test**

`packages/contracts/src/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CAPABILITIES, type Capability, requireCapability } from "./capabilities";
import { CommerceError } from "./errors";

describe("capabilities", () => {
  it("lists each capability once", () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    expect(CAPABILITIES).toContain("orders.lookup");
  });

  it("requireCapability passes when declared", () => {
    const provider = { platform: "test", capabilities: new Set<Capability>(["cart.write"]) };
    expect(() => requireCapability(provider, "cart.write")).not.toThrow();
  });

  it("requireCapability throws NOT_SUPPORTED when missing", () => {
    const provider = { platform: "test", capabilities: new Set<Capability>() };
    try {
      requireCapability(provider, "orders.lookup");
      expect.unreachable("requireCapability should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError);
      expect(error).toMatchObject({ code: "NOT_SUPPORTED", details: { capability: "orders.lookup" } });
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ace/contracts test`
Expected: FAIL with "Failed to resolve import "./capabilities"".

- [x] **Step 3: Implement capabilities, provider interface and index**

`packages/contracts/src/capabilities.ts`:

```ts
import { CommerceError } from "./errors";

export const CAPABILITIES = [
  "catalog.search",
  "catalog.read",
  "catalog.list",
  "inventory.read",
  "cart.write",
  "checkout.handoff",
  "orders.lookup",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function requireCapability(
  provider: { platform: string; capabilities: ReadonlySet<Capability> },
  capability: Capability,
): void {
  if (!provider.capabilities.has(capability)) {
    throw new CommerceError("NOT_SUPPORTED", `${provider.platform} does not support ${capability}`, {
      capability,
    });
  }
}
```

`packages/contracts/src/provider.ts`:

```ts
import type { Capability } from "./capabilities";
import type { AddCartLinesInput, Cart, CreateCartInput, UpdateCartLineInput, WriteOptions } from "./cart";
import type {
  ListProductsInput,
  ListProductsResult,
  Product,
  SearchProductsInput,
  SearchProductsResult,
} from "./catalog";
import type { CheckoutHandoff } from "./checkout";
import type { InventoryLevel } from "./inventory";
import type { ListOrdersInput, LookupOrderInput, Order } from "./orders";

/**
 * The only way the agent talks to a store. One instance per connected store; credentials are bound
 * when the adapter is constructed, so no method takes a tenant or store ID.
 *
 * Rules for implementers (enforced by describeProviderConformance):
 * - Validate every input with parseInput(schema, value) → CommerceError("INVALID_INPUT").
 * - Throw CommerceError for every expected failure; translate platform errors, never leak them.
 * - Methods whose capability is not declared throw CommerceError("NOT_SUPPORTED").
 * - Writes are idempotent per opts.idempotencyKey: a replay returns the first result.
 * - Writes are atomic: when a write throws, nothing changed.
 * - Money is integer minor units.
 */
export interface CommerceProvider {
  /** Lowercase platform id: "memory", "medusa", "shopify", … */
  readonly platform: string;
  readonly capabilities: ReadonlySet<Capability>;

  /** catalog.search */
  searchProducts(input: SearchProductsInput): Promise<SearchProductsResult>;
  /** catalog.read — null when the product does not exist or is not published. */
  getProduct(productId: string): Promise<Product | null>;
  /** catalog.list — stable order for sync; `updatedSince` is inclusive. */
  listProducts(input: ListProductsInput): Promise<ListProductsResult>;
  /** inventory.read — unknown variant IDs are omitted from the result. */
  getInventory(variantIds: string[]): Promise<InventoryLevel[]>;

  /** cart.write */
  createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart>;
  /** cart.write — null when the cart does not exist. */
  getCart(cartId: string): Promise<Cart | null>;
  /** cart.write — merges lines for the same variant. NOT_FOUND (cart/variant), OUT_OF_STOCK, INVALID_INPUT. */
  addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart>;
  /** cart.write — quantity 0 removes the line. */
  updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart>;

  /** checkout.handoff — CONFLICT for an empty cart; OUT_OF_STOCK if a line can no longer be fulfilled. */
  createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff>;

  /** orders.lookup — null when the order does not exist OR is not owned by input.identity. */
  lookupOrder(input: LookupOrderInput): Promise<Order | null>;
  /** orders.lookup — newest first, only orders owned by input.identity. */
  listOrders(input: ListOrdersInput): Promise<Order[]>;
}
```

`packages/contracts/src/index.ts`:

```ts
export * from "./capabilities";
export * from "./cart";
export * from "./catalog";
export * from "./checkout";
export * from "./errors";
export * from "./identity";
export * from "./inventory";
export * from "./money";
export * from "./orders";
export type { CommerceProvider } from "./provider";
```

- [x] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @ace/contracts test && pnpm typecheck`
Expected: PASS — 6 files, 39 tests; typecheck clean.

- [x] **Step 5: Write ADR-001**

`docs/adr/001-commerce-contract.md`:

```markdown
# ADR-001: Universal commerce contract

- Status: Accepted (2026-10-08)
- Context: The agent must work with any store platform (own reference store, Shopify, WooCommerce, custom APIs)
  without code changes. See design spec §3.2 J1 and §4.2.

## Decision

The agent depends only on `CommerceProvider` from `@ace/contracts`:

- One provider instance per connected store; credentials bound at construction.
- Capabilities declare what an adapter supports; the agent registers only matching tools.
- Money is integer minor units + ISO 4217 code.
- Every expected failure is a typed `CommerceError` (`NOT_FOUND`, `INVALID_INPUT`, `OUT_OF_STOCK`, `NOT_SUPPORTED`,
  `UNAUTHORIZED`, `CONFLICT`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`).
- Writes take an idempotency key and are atomic.
- Order access requires a server-verified `VerifiedIdentity`; lookups return `null` for non-owners.
- Checkout is a URL handoff; the agent never handles payment data.
- Vocabulary follows the Universal Commerce Protocol's catalog / cart / checkout concepts, so UCP-based adapters stay
  thin.
- Every adapter must pass `describeProviderConformance` from `@ace/contracts/testing`.

## Consequences

- Adding a platform = writing one adapter package plus running the conformance suite.
- Contract changes are versioned. Additive changes add a capability; breaking changes need a new ADR.
```

- [x] **Step 6: Lint and commit**

```bash
pnpm lint:fix && pnpm lint
git add packages/contracts docs/adr
git commit -m "feat(contracts): add capabilities and CommerceProvider interface; docs: ADR-001"
```

---

### Task 5: Adapter conformance suite (`@ace/contracts/testing`)

**Files:**
- Create: `packages/contracts/src/testing/fixtures.ts`, `packages/contracts/src/testing/conformance.ts`, `packages/contracts/src/testing/index.ts`
- Test: `packages/contracts/src/testing/conformance.self.test.ts`

**Interfaces:**
- Consumes: `CommerceProvider`, schemas, `CommerceError`, `ATTRIBUTION_ATTRIBUTE`, `VerifiedIdentity`, `Capability` (Tasks 1–4); `sampleProduct` (Task 2).
- Produces:
  - `interface ConformanceFixtures { searchTerm; productId; inStockVariantId; outOfStockVariantId; orderNumber; orderOwner: VerifiedIdentity; stranger: VerifiedIdentity }`
  - `interface ConformanceSubject { provider: CommerceProvider; fixtures: ConformanceFixtures }`
  - `describeProviderConformance(name: string, setup: () => Promise<ConformanceSubject>): void`

- [x] **Step 1: Write the fixtures type**

`packages/contracts/src/testing/fixtures.ts`:

```ts
import type { VerifiedIdentity } from "../identity";
import type { CommerceProvider } from "../provider";

/** Store data each adapter must provide so the conformance suite can run against it. */
export interface ConformanceFixtures {
  /** Query that matches at least 2 products. */
  searchTerm: string;
  /** A published product. */
  productId: string;
  /** A variant with at least 2 units available. */
  inStockVariantId: string;
  /** A variant with 0 units available. */
  outOfStockVariantId: string;
  /** An existing order owned by `orderOwner`. */
  orderNumber: string;
  orderOwner: VerifiedIdentity;
  /** An identity that owns no orders. */
  stranger: VerifiedIdentity;
}

export interface ConformanceSubject {
  provider: CommerceProvider;
  fixtures: ConformanceFixtures;
}
```

- [x] **Step 2: Write the failing self-test**

`packages/contracts/src/testing/conformance.self.test.ts`:

```ts
import type { Capability } from "../capabilities";
import { CommerceError } from "../errors";
import type { CommerceProvider } from "../provider";
import { sampleProduct } from "../test-fixtures";
import { describeProviderConformance } from "./conformance";

const notSupported = () => Promise.reject(new CommerceError("NOT_SUPPORTED", "stub"));
const verifiedAt = "2026-10-01T00:00:00.000Z";

/** Declares only catalog.read: the suite must run that test and skip every other capability test. */
function readOnlyStub(): CommerceProvider {
  const product = sampleProduct();
  return {
    platform: "stub",
    capabilities: new Set<Capability>(["catalog.read"]),
    getProduct: async (id) => (id === product.id ? product : null),
    searchProducts: notSupported,
    listProducts: notSupported,
    getInventory: notSupported,
    createCart: notSupported,
    getCart: notSupported,
    addCartLines: notSupported,
    updateCartLine: notSupported,
    createCheckout: notSupported,
    lookupOrder: notSupported,
    listOrders: notSupported,
  };
}

describeProviderConformance("read-only stub", async () => ({
  provider: readOnlyStub(),
  fixtures: {
    searchTerm: "dress",
    productId: "prod_dress",
    inStockVariantId: "unused",
    outOfStockVariantId: "unused",
    orderNumber: "unused",
    orderOwner: { method: "email_otp", email: "owner@example.com", verifiedAt },
    stranger: { method: "email_otp", email: "stranger@example.com", verifiedAt },
  },
}));
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ace/contracts test`
Expected: FAIL with "Failed to resolve import "./conformance"".

- [x] **Step 4: Implement the suite**

`packages/contracts/src/testing/conformance.ts`:

```ts
import { beforeEach, describe, expect, it, type TestContext } from "vitest";
import type { Capability } from "../capabilities";
import { ATTRIBUTION_ATTRIBUTE, type Cart, type CartLine, CartSchema } from "../cart";
import { ListProductsResultSchema, ProductSchema, SearchProductsResultSchema } from "../catalog";
import { CheckoutHandoffSchema } from "../checkout";
import { CommerceError, type CommerceErrorCode } from "../errors";
import type { VerifiedIdentity } from "../identity";
import { InventoryLevelSchema } from "../inventory";
import { OrderSchema } from "../orders";
import type { CommerceProvider } from "../provider";
import type { ConformanceFixtures, ConformanceSubject } from "./fixtures";

let keyCounter = 0;
function writeKey(): { idempotencyKey: string } {
  keyCounter += 1;
  return { idempotencyKey: `conformance-${Date.now()}-${keyCounter}` };
}

async function expectCommerceError(promise: Promise<unknown>, code: CommerceErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CommerceError);
  await expect(promise).rejects.toMatchObject({ code });
}

function onlyLine(cart: Cart): CartLine {
  expect(cart.lines).toHaveLength(1);
  const [line] = cart.lines;
  if (!line) throw new Error("expected exactly one cart line");
  return line;
}

/** Registers the contract test suite every CommerceProvider adapter must pass. */
export function describeProviderConformance(name: string, setup: () => Promise<ConformanceSubject>): void {
  describe(`CommerceProvider conformance: ${name}`, () => {
    let provider: CommerceProvider;
    let f: ConformanceFixtures;

    beforeEach(async () => {
      ({ provider, fixtures: f } = await setup());
    });

    function needs(ctx: TestContext, ...capabilities: Capability[]): void {
      if (!capabilities.every((capability) => provider.capabilities.has(capability))) ctx.skip();
    }

    async function newCart(): Promise<Cart> {
      return provider.createCart({ attributes: { [ATTRIBUTION_ATTRIBUTE]: "conv_conformance" } }, writeKey());
    }

    it("declares a lowercase platform id and at least one capability", () => {
      expect(provider.platform).toMatch(/^[a-z0-9-]+$/);
      expect(provider.capabilities.size).toBeGreaterThan(0);
    });

    // catalog -------------------------------------------------------------

    it("searchProducts returns schema-valid results", async (ctx) => {
      needs(ctx, "catalog.search");
      const result = await provider.searchProducts({ query: f.searchTerm });
      expect(() => SearchProductsResultSchema.parse(result)).not.toThrow();
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("searchProducts pages with limit and cursor without repeating items", async (ctx) => {
      needs(ctx, "catalog.search");
      const first = await provider.searchProducts({ query: f.searchTerm, limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await provider.searchProducts({
        query: f.searchTerm,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it("searchProducts rejects invalid input with INVALID_INPUT", async (ctx) => {
      needs(ctx, "catalog.search");
      await expectCommerceError(provider.searchProducts({ limit: 500 }), "INVALID_INPUT");
    });

    it("getProduct returns a valid product, and null for an unknown id", async (ctx) => {
      needs(ctx, "catalog.read");
      const product = await provider.getProduct(f.productId);
      expect(product).not.toBeNull();
      expect(() => ProductSchema.parse(product)).not.toThrow();
      expect(await provider.getProduct("does-not-exist-000")).toBeNull();
    });

    it("listProducts returns schema-valid pages", async (ctx) => {
      needs(ctx, "catalog.list");
      const page = await provider.listProducts({ limit: 2 });
      expect(() => ListProductsResultSchema.parse(page)).not.toThrow();
      expect(page.items.length).toBeGreaterThan(0);
    });

    it("getInventory reports in-stock and out-of-stock variants", async (ctx) => {
      needs(ctx, "inventory.read");
      const levels = await provider.getInventory([f.inStockVariantId, f.outOfStockVariantId]);
      for (const level of levels) expect(() => InventoryLevelSchema.parse(level)).not.toThrow();
      const byId = new Map(levels.map((level) => [level.variantId, level]));
      expect(byId.get(f.inStockVariantId)?.availability).toMatch(/^(in_stock|low_stock)$/);
      expect(byId.get(f.outOfStockVariantId)?.availability).toBe("out_of_stock");
    });

    // cart ----------------------------------------------------------------

    it("createCart returns an empty cart that keeps attributes", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      expect(() => CartSchema.parse(cart)).not.toThrow();
      expect(cart.lines).toHaveLength(0);
      expect(cart.itemCount).toBe(0);
      expect(cart.subtotal.amount).toBe(0);
      expect(cart.attributes[ATTRIBUTION_ATTRIBUTE]).toBe("conv_conformance");
      expect(await provider.getCart(cart.id)).toEqual(cart);
    });

    it("addCartLines adds a line and computes totals", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const updated = await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 2 }] },
        writeKey(),
      );
      expect(() => CartSchema.parse(updated)).not.toThrow();
      const line = onlyLine(updated);
      expect(line.variantId).toBe(f.inStockVariantId);
      expect(line.quantity).toBe(2);
      expect(line.lineTotal.amount).toBe(line.unitPrice.amount * 2);
      expect(updated.subtotal.amount).toBe(line.lineTotal.amount);
      expect(updated.itemCount).toBe(2);
    });

    it("adding the same variant twice merges into one line", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const line = { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] };
      await provider.addCartLines(cart.id, line, writeKey());
      const updated = await provider.addCartLines(cart.id, line, writeKey());
      expect(onlyLine(updated).quantity).toBe(2);
    });

    it("replaying an idempotency key does not add twice", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const opts = writeKey();
      const input = { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] };
      const first = await provider.addCartLines(cart.id, input, opts);
      const replay = await provider.addCartLines(cart.id, input, opts);
      expect(replay.itemCount).toBe(1);
      expect(replay).toEqual(first);
    });

    it("rejects out-of-stock variants and leaves the cart unchanged", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      await expectCommerceError(
        provider.addCartLines(cart.id, { lines: [{ variantId: f.outOfStockVariantId, quantity: 1 }] }, writeKey()),
        "OUT_OF_STOCK",
      );
      expect((await provider.getCart(cart.id))?.lines).toHaveLength(0);
    });

    it("rejects invalid quantities with INVALID_INPUT", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      for (const quantity of [0, -1, 1.5, 21]) {
        await expectCommerceError(
          provider.addCartLines(cart.id, { lines: [{ variantId: f.inStockVariantId, quantity }] }, writeKey()),
          "INVALID_INPUT",
        );
      }
    });

    it("returns null / NOT_FOUND for unknown carts and variants", async (ctx) => {
      needs(ctx, "cart.write");
      expect(await provider.getCart("no-such-cart")).toBeNull();
      await expectCommerceError(
        provider.addCartLines("no-such-cart", { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] }, writeKey()),
        "NOT_FOUND",
      );
      const cart = await newCart();
      await expectCommerceError(
        provider.addCartLines(cart.id, { lines: [{ variantId: "no-such-variant", quantity: 1 }] }, writeKey()),
        "NOT_FOUND",
      );
    });

    it("updateCartLine changes quantity and removes the line at 0", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const added = await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] },
        writeKey(),
      );
      const lineId = onlyLine(added).id;
      const changed = await provider.updateCartLine(cart.id, { lineId, quantity: 2 }, writeKey());
      expect(onlyLine(changed).quantity).toBe(2);
      const removed = await provider.updateCartLine(cart.id, { lineId, quantity: 0 }, writeKey());
      expect(removed.lines).toHaveLength(0);
      expect(removed.subtotal.amount).toBe(0);
    });

    // checkout ------------------------------------------------------------

    it("createCheckout returns CONFLICT for an empty cart and a handoff URL otherwise", async (ctx) => {
      needs(ctx, "cart.write", "checkout.handoff");
      const cart = await newCart();
      await expectCommerceError(provider.createCheckout(cart.id, writeKey()), "CONFLICT");
      await provider.addCartLines(cart.id, { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] }, writeKey());
      const handoff = await provider.createCheckout(cart.id, writeKey());
      expect(() => CheckoutHandoffSchema.parse(handoff)).not.toThrow();
      expect(handoff.cartId).toBe(cart.id);
    });

    // orders --------------------------------------------------------------

    it("lookupOrder returns the order to its owner and null to anyone else", async (ctx) => {
      needs(ctx, "orders.lookup");
      const order = await provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.orderOwner });
      expect(order).not.toBeNull();
      expect(() => OrderSchema.parse(order)).not.toThrow();
      expect(await provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.stranger })).toBeNull();
      expect(await provider.lookupOrder({ orderNumber: "NO-SUCH-ORDER", identity: f.orderOwner })).toBeNull();
    });

    it("lookupOrder rejects an identity without identifiers", async (ctx) => {
      needs(ctx, "orders.lookup");
      const empty = { method: "email_otp", verifiedAt: new Date().toISOString() } as VerifiedIdentity;
      await expectCommerceError(provider.lookupOrder({ orderNumber: f.orderNumber, identity: empty }), "INVALID_INPUT");
    });

    it("listOrders only returns orders owned by the identity", async (ctx) => {
      needs(ctx, "orders.lookup");
      const mine = await provider.listOrders({ identity: f.orderOwner });
      expect(mine.map((order) => order.number)).toContain(f.orderNumber);
      expect(await provider.listOrders({ identity: f.stranger })).toEqual([]);
    });
  });
}
```

`packages/contracts/src/testing/index.ts`:

```ts
export { describeProviderConformance } from "./conformance";
export type { ConformanceFixtures, ConformanceSubject } from "./fixtures";
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ace/contracts test`
Expected: PASS — the self-test reports **2 passed** (platform id, getProduct) and **17 skipped**, plus the 39 earlier tests.

- [x] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add packages/contracts
git commit -m "feat(contracts): add adapter conformance suite"
```

---

### Task 6: Memory adapter — seed catalog, cursors, search

**Files:**
- Create: `packages/adapter-memory/package.json`, `packages/adapter-memory/tsconfig.json`
- Create: `packages/adapter-memory/src/seed.ts`, `packages/adapter-memory/src/cursor.ts`, `packages/adapter-memory/src/search.ts`
- Test: `packages/adapter-memory/src/cursor.test.ts`, `packages/adapter-memory/src/search.test.ts`

**Interfaces:**
- Consumes: `Product`, `Order`, `Money`, `SearchProductsInput`, `SearchProductsInputSchema`, `SearchFilters`, `SearchProductsResult`, `Variant`, `parseInput`, `summarizeProduct`, `CommerceError` (`@ace/contracts`); `ConformanceFixtures` type (`@ace/contracts/testing`).
- Produces:
  - `interface SeedOrder { order: Order; owner: OrderOwner }`, `interface MemorySeed { currency: string; products: Product[]; stock: Record<string, number>; orders: SeedOrder[] }`
  - `defaultSeed(): MemorySeed` (fresh deep copy each call), `memoryFixtures: ConformanceFixtures`
  - `encodeCursor(offset: number): string`, `decodeCursor(cursor: string | undefined): number`
  - `searchCatalog(products: Product[], input: SearchProductsInput): SearchProductsResult`

- [x] **Step 1: Create the package shell**

`packages/adapter-memory/package.json`:

```json
{
  "name": "@ace/adapter-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/adapter-memory/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm --filter @ace/adapter-memory add @ace/contracts@workspace:*
pnpm --filter @ace/adapter-memory add -D vitest typescript
```

- [x] **Step 2: Write the seed data**

`packages/adapter-memory/src/seed.ts`:

```ts
import type { Money, Order, OrderOwner, Product, VerifiedIdentity } from "@ace/contracts";
import type { ConformanceFixtures } from "@ace/contracts/testing";

export interface SeedOrder {
  order: Order;
  owner: OrderOwner;
}

export interface MemorySeed {
  currency: string;
  products: Product[];
  /** variantId → units available. Variant availability is derived from this at read time. */
  stock: Record<string, number>;
  orders: SeedOrder[];
}

const UPDATED_AT = "2026-10-01T00:00:00.000Z";
const BASE_URL = "https://demo-store.test";

function lkr(rupees: number): Money {
  return { amount: rupees * 100, currency: "LKR" };
}

interface ProductSpec {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  attributes: Record<string, string[]>;
  color: string;
  sizes: string[];
  priceRupees: number;
}

function clothingProduct(spec: ProductSpec): Product {
  const handle = spec.id.replace(/^p_/, "").replaceAll("_", "-");
  const price = lkr(spec.priceRupees);
  return {
    id: spec.id,
    handle,
    title: spec.title,
    description: spec.description,
    url: `${BASE_URL}/products/${handle}`,
    category: spec.category,
    tags: spec.tags,
    attributes: spec.attributes,
    images: [{ url: `${BASE_URL}/images/${handle}.jpg`, alt: spec.title }],
    options: [
      { name: "color", values: [spec.color] },
      { name: "size", values: spec.sizes },
    ],
    variants: spec.sizes.map((size) => ({
      id: `${spec.id}_${size.toLowerCase()}`,
      productId: spec.id,
      sku: `${handle}-${size}`.toUpperCase(),
      title: `${spec.color} / ${size}`,
      options: { color: spec.color, size },
      price,
      availability: "in_stock" as const,
    })),
    priceRange: { min: price, max: price },
    updatedAt: UPDATED_AT,
  };
}

const PRODUCTS: ProductSpec[] = [
  {
    id: "p_linen_shirt_black",
    title: "Black Linen Shirt",
    description: "Breathable linen shirt with a relaxed fit for hot days.",
    category: "shirt",
    tags: ["men", "summer"],
    attributes: { color: ["black"], fabric: ["linen"], occasion: ["casual", "office"] },
    color: "Black",
    sizes: ["S", "M", "L"],
    priceRupees: 6500,
  },
  {
    id: "p_oxford_shirt_white",
    title: "White Oxford Shirt",
    description: "Classic cotton oxford shirt.",
    category: "shirt",
    tags: ["men"],
    attributes: { color: ["white"], fabric: ["cotton"], occasion: ["office", "formal"] },
    color: "White",
    sizes: ["M", "L", "XL"],
    priceRupees: 5900,
  },
  {
    id: "p_wrap_dress_black",
    title: "Black Satin Wrap Dress",
    description: "Elegant satin wrap dress for evening events and weddings.",
    category: "dress",
    tags: ["women", "evening"],
    attributes: { color: ["black"], fabric: ["satin"], occasion: ["wedding", "party", "formal"] },
    color: "Black",
    sizes: ["S", "M", "L"],
    priceRupees: 18500,
  },
  {
    id: "p_maxi_dress_floral",
    title: "Floral Maxi Dress",
    description: "Light floral maxi dress for the beach and weekends.",
    category: "dress",
    tags: ["women", "summer"],
    attributes: { color: ["multicolor"], pattern: ["floral"], occasion: ["casual", "beach"] },
    color: "Floral",
    sizes: ["S", "M"],
    priceRupees: 12900,
  },
  {
    id: "p_kurta_navy",
    title: "Navy Cotton Kurta",
    description: "Cotton kurta for festive occasions.",
    category: "kurta",
    tags: ["men", "festive"],
    attributes: { color: ["navy"], fabric: ["cotton"], occasion: ["festive", "casual"] },
    color: "Navy",
    sizes: ["M", "L"],
    priceRupees: 7900,
  },
  {
    id: "p_chinos_black",
    title: "Black Slim Chinos",
    description: "Slim-fit stretch chinos.",
    category: "trousers",
    tags: ["men"],
    attributes: { color: ["black"], fabric: ["cotton"], occasion: ["office", "casual"] },
    color: "Black",
    sizes: ["30", "32", "34"],
    priceRupees: 8900,
  },
];

const STOCK: Record<string, number> = {
  p_linen_shirt_black_s: 5,
  p_linen_shirt_black_m: 3,
  p_linen_shirt_black_l: 0,
  p_oxford_shirt_white_m: 10,
  p_oxford_shirt_white_l: 2,
  p_oxford_shirt_white_xl: 1,
  p_wrap_dress_black_s: 2,
  p_wrap_dress_black_m: 4,
  p_wrap_dress_black_l: 1,
  p_maxi_dress_floral_s: 0,
  p_maxi_dress_floral_m: 6,
  p_kurta_navy_m: 4,
  p_kurta_navy_l: 4,
  p_chinos_black_30: 3,
  p_chinos_black_32: 3,
  p_chinos_black_34: 0,
};

const ORDERS: SeedOrder[] = [
  {
    order: {
      id: "ord_1001",
      number: "ACE-1001",
      status: "shipped",
      paymentStatus: "paid",
      placedAt: "2026-09-28T10:15:00.000Z",
      total: lkr(18500),
      lines: [{ title: "Black Satin Wrap Dress", variantTitle: "Black / M", quantity: 1, unitPrice: lkr(18500) }],
      tracking: [
        { carrier: "Demo Courier", number: "DC123456789", url: "https://tracking.demo-store.test/DC123456789" },
      ],
    },
    owner: { email: "customer@example.com", phone: "+94771234567" },
  },
];

/** A fresh, deep-copied seed — mutating it never affects other providers. */
export function defaultSeed(): MemorySeed {
  return structuredClone({
    currency: "LKR",
    products: PRODUCTS.map(clothingProduct),
    stock: STOCK,
    orders: ORDERS,
  });
}

const verifiedAt = "2026-10-01T00:00:00.000Z";
const owner: VerifiedIdentity = { method: "email_otp", email: "customer@example.com", verifiedAt };
const stranger: VerifiedIdentity = { method: "email_otp", email: "someone-else@example.com", verifiedAt };

export const memoryFixtures: ConformanceFixtures = {
  searchTerm: "black",
  productId: "p_wrap_dress_black",
  inStockVariantId: "p_wrap_dress_black_m",
  outOfStockVariantId: "p_linen_shirt_black_l",
  orderNumber: "ACE-1001",
  orderOwner: owner,
  stranger,
};
```

- [x] **Step 3: Write the failing tests**

`packages/adapter-memory/src/cursor.test.ts`:

```ts
import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("cursor", () => {
  it("round-trips offsets", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(37))).toBe(37);
  });

  it("treats a missing cursor as the first page", () => {
    expect(decodeCursor(undefined)).toBe(0);
  });

  it("rejects garbage and tampered cursors with INVALID_INPUT", () => {
    for (const bad of ["%%%", "bm9wZQ", btoa("o:-1"), btoa("o:1.5"), btoa("offset:3")]) {
      expect(() => decodeCursor(bad), bad).toThrow(CommerceError);
    }
  });
});
```

`packages/adapter-memory/src/search.test.ts`:

```ts
import type { Product } from "@ace/contracts";
import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { searchCatalog } from "./search";
import { defaultSeed } from "./seed";

const products = (): Product[] => defaultSeed().products;
const ids = (result: { items: { id: string }[] }) => result.items.map((item) => item.id);

describe("searchCatalog", () => {
  it("matches words in attributes, case-insensitively", () => {
    expect(ids(searchCatalog(products(), { query: "WEDDING" }))).toEqual(["p_wrap_dress_black"]);
  });

  it("ranks products matching more query words first", () => {
    expect(ids(searchCatalog(products(), { query: "black dress" }))[0]).toBe("p_wrap_dress_black");
  });

  it("returns nothing when no word matches", () => {
    expect(searchCatalog(products(), { query: "tuxedo" })).toEqual({ items: [], nextCursor: null });
  });

  it("filters by category and option values", () => {
    const result = searchCatalog(products(), {
      filters: { category: "Shirt", options: { size: ["XL"] } },
    });
    expect(ids(result)).toEqual(["p_oxford_shirt_white"]);
    expect(result.items[0]?.matchingVariantIds).toEqual(["p_oxford_shirt_white_xl"]);
  });

  it("applies inclusive price bounds in minor units", () => {
    const result = searchCatalog(products(), { filters: { priceMin: 590000, priceMax: 650000 } });
    expect(ids(result).sort()).toEqual(["p_linen_shirt_black", "p_oxford_shirt_white"]);
  });

  it("excludes out-of-stock variants when inStockOnly is set", () => {
    const catalog = products().map((product) => ({
      ...product,
      variants: product.variants.map((variant) => ({ ...variant, availability: "out_of_stock" as const })),
    }));
    expect(searchCatalog(catalog, { filters: { inStockOnly: true } }).items).toEqual([]);
  });

  it("pages with an opaque cursor", () => {
    const first = searchCatalog(products(), { query: "black", limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = searchCatalog(products(), { query: "black", limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(3);
  });

  it("rejects invalid input with INVALID_INPUT", () => {
    expect(() => searchCatalog(products(), { limit: 0 })).toThrow(CommerceError);
    expect(() => searchCatalog(products(), { cursor: "garbage!" })).toThrow(CommerceError);
  });
});
```

- [x] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: FAIL with "Failed to resolve import "./cursor"" and "./search".

- [x] **Step 5: Implement `cursor.ts` and `search.ts`**

`packages/adapter-memory/src/cursor.ts`:

```ts
import { CommerceError } from "@ace/contracts";

export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`);
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw new CommerceError("INVALID_INPUT", "Invalid cursor");
  }
  const match = /^o:(\d+)$/.exec(decoded);
  const digits = match?.[1];
  if (digits === undefined) throw new CommerceError("INVALID_INPUT", "Invalid cursor");
  return Number(digits);
}
```

`packages/adapter-memory/src/search.ts`:

```ts
import {
  type Product,
  parseInput,
  type SearchFilters,
  type SearchProductsInput,
  SearchProductsInputSchema,
  type SearchProductsResult,
  summarizeProduct,
  type Variant,
} from "@ace/contracts";
import { decodeCursor, encodeCursor } from "./cursor";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function productWords(product: Product): Set<string> {
  const text = [
    product.title,
    product.description,
    product.category ?? "",
    ...product.tags,
    ...Object.values(product.attributes).flat(),
    ...product.variants.flatMap((variant) => Object.values(variant.options)),
  ].join(" ");
  return new Set(words(text));
}

function variantMatches(variant: Variant, filters: SearchFilters): boolean {
  if (filters.inStockOnly && variant.availability === "out_of_stock") return false;
  if (filters.priceMin !== undefined && variant.price.amount < filters.priceMin) return false;
  if (filters.priceMax !== undefined && variant.price.amount > filters.priceMax) return false;
  for (const [name, accepted] of Object.entries(filters.options ?? {})) {
    const actual = variant.options[name]?.toLowerCase();
    if (actual === undefined || !accepted.some((value) => value.toLowerCase() === actual)) return false;
  }
  return true;
}

/** Simple word-overlap search used by the in-memory adapter. Real adapters use platform or index search. */
export function searchCatalog(products: Product[], input: SearchProductsInput): SearchProductsResult {
  const query = parseInput(SearchProductsInputSchema, input);
  const offset = decodeCursor(query.cursor);
  const queryWords = query.query ? words(query.query) : [];
  const category = query.filters.category?.toLowerCase();

  const matches: { product: Product; variantIds: string[]; score: number }[] = [];
  for (const product of products) {
    if (category !== undefined && product.category?.toLowerCase() !== category) continue;
    const variantIds = product.variants
      .filter((variant) => variantMatches(variant, query.filters))
      .map((variant) => variant.id);
    if (variantIds.length === 0) continue;
    let score = 0;
    if (queryWords.length > 0) {
      const haystack = productWords(product);
      score = queryWords.filter((word) => haystack.has(word)).length;
      if (score === 0) continue;
    }
    matches.push({ product, variantIds, score });
  }

  matches.sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title));
  const page = matches.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    items: page.map((match) => summarizeProduct(match.product, match.variantIds)),
    nextCursor: nextOffset < matches.length ? encodeCursor(nextOffset) : null,
  };
}
```

- [x] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: PASS — 2 files, 11 tests.

- [x] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add packages/adapter-memory pnpm-lock.yaml
git commit -m "feat(adapter-memory): add seeded clothing catalog, cursors and search"
```

---

### Task 7: Memory provider — catalog, inventory and orders

**Files:**
- Create: `packages/adapter-memory/src/memory-provider.ts`, `packages/adapter-memory/src/index.ts`
- Test: `packages/adapter-memory/src/memory-provider.test.ts`

**Interfaces:**
- Consumes: Task 6 exports; `CommerceProvider`, `Capability`, schemas, `parseInput`, `identityMatches`, `CommerceError` (`@ace/contracts`).
- Produces:
  - `LOW_STOCK_THRESHOLD = 2`, `availabilityFor(quantity: number): Availability` (0 → out_of_stock, 1–2 → low_stock, else in_stock)
  - `interface MemoryProviderOptions { seed?: MemorySeed; now?: () => Date; checkoutBaseUrl?: string }`
  - `class MemoryCommerceProvider implements CommerceProvider` with read methods implemented. In this task, the cart and checkout methods throw `NOT_SUPPORTED`, and `cart.write`/`checkout.handoff` are not declared yet.

- [x] **Step 1: Write the failing tests**

`packages/adapter-memory/src/memory-provider.test.ts`:

```ts
import type { VerifiedIdentity } from "@ace/contracts";
import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { availabilityFor, MemoryCommerceProvider } from "./memory-provider";

const verifiedAt = "2026-10-01T00:00:00.000Z";
const byEmail = (email: string): VerifiedIdentity => ({ method: "email_otp", email, verifiedAt });

describe("availabilityFor", () => {
  it("derives availability from units in stock", () => {
    expect(availabilityFor(0)).toBe("out_of_stock");
    expect(availabilityFor(1)).toBe("low_stock");
    expect(availabilityFor(2)).toBe("low_stock");
    expect(availabilityFor(3)).toBe("in_stock");
  });
});

describe("MemoryCommerceProvider — catalog and inventory", () => {
  it("returns products with availability derived from stock", async () => {
    const provider = new MemoryCommerceProvider();
    const shirt = await provider.getProduct("p_linen_shirt_black");
    const availability = Object.fromEntries(shirt?.variants.map((v) => [v.title, v.availability] as const) ?? []);
    expect(availability).toEqual({
      "Black / S": "in_stock",
      "Black / M": "in_stock",
      "Black / L": "out_of_stock",
    });
  });

  it("search with inStockOnly + size L skips the sold-out linen shirt but keeps the low-stock dress", async () => {
    const provider = new MemoryCommerceProvider();
    const result = await provider.searchProducts({
      query: "black",
      filters: { options: { size: ["L"] }, inStockOnly: true },
    });
    expect(result.items.map((item) => item.id)).toEqual(["p_wrap_dress_black"]);
  });

  it("getInventory omits unknown variant ids", async () => {
    const provider = new MemoryCommerceProvider();
    const levels = await provider.getInventory(["p_wrap_dress_black_l", "nope"]);
    expect(levels).toEqual([{ variantId: "p_wrap_dress_black_l", availability: "low_stock", quantityAvailable: 1 }]);
  });

  it("getInventory rejects an empty id list", async () => {
    const provider = new MemoryCommerceProvider();
    await expect(provider.getInventory([])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("listProducts pages in stable id order and honours updatedSince", async () => {
    const provider = new MemoryCommerceProvider();
    const first = await provider.listProducts({ limit: 4 });
    const second = await provider.listProducts({ limit: 4, cursor: first.nextCursor ?? undefined });
    const all = [...first.items, ...second.items].map((p) => p.id);
    expect(all).toEqual([...all].sort());
    expect(all).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect((await provider.listProducts({ updatedSince: "2030-01-01T00:00:00.000Z" })).items).toEqual([]);
  });

  it("does not declare cart capabilities yet", async () => {
    const provider = new MemoryCommerceProvider();
    expect(provider.capabilities.has("cart.write")).toBe(false);
    await expect(provider.getCart("x")).rejects.toBeInstanceOf(CommerceError);
  });
});

describe("MemoryCommerceProvider — orders", () => {
  it("finds an order for its owner regardless of order-number case", async () => {
    const provider = new MemoryCommerceProvider();
    const order = await provider.lookupOrder({ orderNumber: "ace-1001", identity: byEmail("customer@example.com") });
    expect(order?.number).toBe("ACE-1001");
  });

  it("finds an order by the owner's phone", async () => {
    const provider = new MemoryCommerceProvider();
    const identity: VerifiedIdentity = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect((await provider.lookupOrder({ orderNumber: "ACE-1001", identity }))?.id).toBe("ord_1001");
  });

  it("returns null to a stranger, exactly as for a missing order", async () => {
    const provider = new MemoryCommerceProvider();
    const stranger = byEmail("someone-else@example.com");
    expect(await provider.lookupOrder({ orderNumber: "ACE-1001", identity: stranger })).toBeNull();
    expect(await provider.lookupOrder({ orderNumber: "ACE-9999", identity: stranger })).toBeNull();
  });

  it("returns copies, so callers cannot mutate stored orders", async () => {
    const provider = new MemoryCommerceProvider();
    const identity = byEmail("customer@example.com");
    const order = await provider.lookupOrder({ orderNumber: "ACE-1001", identity });
    if (order) order.status = "cancelled";
    expect((await provider.lookupOrder({ orderNumber: "ACE-1001", identity }))?.status).toBe("shipped");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: FAIL with "Failed to resolve import "./memory-provider"".

- [x] **Step 3: Implement the read side**

`packages/adapter-memory/src/memory-provider.ts`:

```ts
import {
  type AddCartLinesInput,
  type Availability,
  type Capability,
  type Cart,
  type CheckoutHandoff,
  CommerceError,
  type CommerceProvider,
  type CreateCartInput,
  GetInventoryInputSchema,
  identityMatches,
  type InventoryLevel,
  type ListOrdersInput,
  ListOrdersInputSchema,
  type ListProductsInput,
  ListProductsInputSchema,
  type ListProductsResult,
  type LookupOrderInput,
  LookupOrderInputSchema,
  type Order,
  type Product,
  parseInput,
  type SearchProductsInput,
  type SearchProductsResult,
  type UpdateCartLineInput,
  type WriteOptions,
} from "@ace/contracts";
import { decodeCursor, encodeCursor } from "./cursor";
import { searchCatalog } from "./search";
import { defaultSeed, type MemorySeed } from "./seed";

export const LOW_STOCK_THRESHOLD = 2;

export function availabilityFor(quantity: number): Availability {
  if (quantity <= 0) return "out_of_stock";
  if (quantity <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

export interface MemoryProviderOptions {
  seed?: MemorySeed;
  now?: () => Date;
  checkoutBaseUrl?: string;
}

const READ_CAPABILITIES: Capability[] = [
  "catalog.search",
  "catalog.read",
  "catalog.list",
  "inventory.read",
  "orders.lookup",
];

const notYet = (operation: string) => new CommerceError("NOT_SUPPORTED", `memory provider: ${operation}`);

export class MemoryCommerceProvider implements CommerceProvider {
  readonly platform = "memory";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(READ_CAPABILITIES);

  protected readonly seed: MemorySeed;
  protected readonly now: () => Date;
  protected readonly checkoutBaseUrl: string;

  constructor(options: MemoryProviderOptions = {}) {
    this.seed = structuredClone(options.seed ?? defaultSeed());
    this.now = options.now ?? (() => new Date());
    this.checkoutBaseUrl = options.checkoutBaseUrl ?? "https://demo-store.test/checkout";
  }

  // catalog ---------------------------------------------------------------

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    return searchCatalog(this.liveProducts(), input);
  }

  async getProduct(productId: string): Promise<Product | null> {
    const product = this.seed.products.find((candidate) => candidate.id === productId);
    return product ? this.withLiveAvailability(product) : null;
  }

  async listProducts(input: ListProductsInput): Promise<ListProductsResult> {
    const query = parseInput(ListProductsInputSchema, input);
    const offset = decodeCursor(query.cursor);
    const since = query.updatedSince ? Date.parse(query.updatedSince) : Number.NEGATIVE_INFINITY;
    const matching = this.liveProducts()
      .filter((product) => Date.parse(product.updatedAt) >= since)
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = matching.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    return { items: page, nextCursor: nextOffset < matching.length ? encodeCursor(nextOffset) : null };
  }

  async getInventory(variantIds: string[]): Promise<InventoryLevel[]> {
    const ids = parseInput(GetInventoryInputSchema, variantIds);
    return ids.flatMap((variantId) => {
      const quantity = this.seed.stock[variantId];
      if (quantity === undefined) return [];
      return [{ variantId, availability: availabilityFor(quantity), quantityAvailable: quantity }];
    });
  }

  // cart + checkout (Task 8) ----------------------------------------------

  async createCart(_input: CreateCartInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("createCart");
  }

  async getCart(_cartId: string): Promise<Cart | null> {
    throw notYet("getCart");
  }

  async addCartLines(_cartId: string, _input: AddCartLinesInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("addCartLines");
  }

  async updateCartLine(_cartId: string, _input: UpdateCartLineInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("updateCartLine");
  }

  async createCheckout(_cartId: string, _opts: WriteOptions): Promise<CheckoutHandoff> {
    throw notYet("createCheckout");
  }

  // orders ----------------------------------------------------------------

  async lookupOrder(input: LookupOrderInput): Promise<Order | null> {
    const query = parseInput(LookupOrderInputSchema, input);
    const wanted = query.orderNumber.toLowerCase();
    const match = this.seed.orders.find((entry) => entry.order.number.toLowerCase() === wanted);
    if (!match || !identityMatches(query.identity, match.owner)) return null;
    return structuredClone(match.order);
  }

  async listOrders(input: ListOrdersInput): Promise<Order[]> {
    const query = parseInput(ListOrdersInputSchema, input);
    return this.seed.orders
      .filter((entry) => identityMatches(query.identity, entry.owner))
      .map((entry) => structuredClone(entry.order))
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .slice(0, query.limit);
  }

  // helpers ---------------------------------------------------------------

  protected liveProducts(): Product[] {
    return this.seed.products.map((product) => this.withLiveAvailability(product));
  }

  protected withLiveAvailability(product: Product): Product {
    const copy = structuredClone(product);
    for (const variant of copy.variants) {
      variant.availability = availabilityFor(this.seed.stock[variant.id] ?? 0);
    }
    return copy;
  }
}
```

`packages/adapter-memory/src/index.ts`:

```ts
export {
  availabilityFor,
  LOW_STOCK_THRESHOLD,
  MemoryCommerceProvider,
  type MemoryProviderOptions,
} from "./memory-provider";
export { searchCatalog } from "./search";
export { defaultSeed, type MemorySeed, memoryFixtures, type SeedOrder } from "./seed";
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: PASS — 3 files, 22 tests.

- [x] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint:fix && pnpm lint && pnpm typecheck
git add packages/adapter-memory
git commit -m "feat(adapter-memory): add read-side provider (catalog, inventory, orders)"
```

---

### Task 8: Memory provider — carts, checkout, idempotency, and full conformance

**Files:**
- Modify: `packages/adapter-memory/src/memory-provider.ts` (replace the Task 7 cart/checkout stubs; declare all capabilities)
- Modify: `packages/adapter-memory/src/memory-provider.test.ts` (replace the "does not declare cart capabilities yet" test; add a cart `describe`)
- Create: `packages/adapter-memory/src/conformance.test.ts`

**Interfaces:**
- Consumes: Task 7 provider; `CreateCartInputSchema`, `AddCartLinesInputSchema`, `UpdateCartLineInputSchema`, `WriteOptionsSchema`, `MAX_LINE_QUANTITY`, `addMoney`, `money`, `multiplyMoney`, `CAPABILITIES` (`@ace/contracts`); `describeProviderConformance` (`@ace/contracts/testing`).
- Produces: `MemoryCommerceProvider` declaring every capability in `CAPABILITIES` and passing the full conformance suite.

- [x] **Step 1: Write the failing tests**

In `packages/adapter-memory/src/memory-provider.test.ts`, replace the test `"does not declare cart capabilities yet"` with:

```ts
  it("declares every capability", () => {
    const provider = new MemoryCommerceProvider();
    expect([...provider.capabilities].sort()).toEqual([...CAPABILITIES].sort());
  });
```

Change the top imports of that file to:

```ts
import type { VerifiedIdentity } from "@ace/contracts";
import { CAPABILITIES, CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { availabilityFor, MemoryCommerceProvider } from "./memory-provider";
import { defaultSeed } from "./seed";
```

Append to the same file:

```ts
describe("MemoryCommerceProvider — carts", () => {
  let counter = 0;
  const key = () => ({ idempotencyKey: `test-key-${++counter}` });
  const add = (variantId: string, quantity: number) => ({ lines: [{ variantId, quantity }] });

  it("refuses to create a cart in a currency the store does not sell", async () => {
    const provider = new MemoryCommerceProvider();
    await expect(provider.createCart({ currency: "USD" }, key())).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses more units than are in stock and reports what is available", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    await expect(provider.addCartLines(cart.id, add("p_wrap_dress_black_m", 5), key())).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
      details: { variantId: "p_wrap_dress_black_m", available: 4 },
    });
    expect((await provider.getCart(cart.id))?.lines).toEqual([]);
  });

  it("is atomic: one failing line in a multi-line add changes nothing", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    const input = {
      lines: [
        { variantId: "p_kurta_navy_m", quantity: 1 },
        { variantId: "p_linen_shirt_black_l", quantity: 1 },
      ],
    };
    await expect(provider.addCartLines(cart.id, input, key())).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    expect((await provider.getCart(cart.id))?.itemCount).toBe(0);
  });

  it("rejects merges that would exceed the per-line maximum", async () => {
    const seed = defaultSeed();
    seed.stock.p_oxford_shirt_white_m = 50;
    const provider = new MemoryCommerceProvider({ seed });
    const cart = await provider.createCart({}, key());
    await provider.addCartLines(cart.id, add("p_oxford_shirt_white_m", 20), key());
    await expect(provider.addCartLines(cart.id, add("p_oxford_shirt_white_m", 1), key())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects an update to more units than are in stock", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    const added = await provider.addCartLines(cart.id, add("p_wrap_dress_black_l", 1), key());
    const lineId = added.lines[0]?.id ?? "";
    await expect(provider.updateCartLine(cart.id, { lineId, quantity: 2 }, key())).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
  });

  it("scopes idempotency keys to the cart", async () => {
    const provider = new MemoryCommerceProvider();
    const a = await provider.createCart({}, key());
    const b = await provider.createCart({}, key());
    const shared = key();
    await provider.addCartLines(a.id, add("p_kurta_navy_m", 1), shared);
    const resultB = await provider.addCartLines(b.id, add("p_kurta_navy_m", 1), shared);
    expect(resultB.id).toBe(b.id);
    expect(resultB.itemCount).toBe(1);
  });

  it("keeps carts separate between provider instances", async () => {
    const first = new MemoryCommerceProvider();
    const second = new MemoryCommerceProvider();
    const cart = await first.createCart({}, key());
    expect(await second.getCart(cart.id)).toBeNull();
  });

  it("builds the checkout URL from the configured base", async () => {
    const provider = new MemoryCommerceProvider({ checkoutBaseUrl: "https://shop.test/pay" });
    const cart = await provider.createCart({}, key());
    await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), key());
    const handoff = await provider.createCheckout(cart.id, key());
    expect(handoff).toEqual({ cartId: cart.id, url: `https://shop.test/pay/${cart.id}`, expiresAt: null });
  });

  it("uses the injected clock for updatedAt", async () => {
    const provider = new MemoryCommerceProvider({ now: () => new Date("2026-10-08T12:00:00.000Z") });
    const cart = await provider.createCart({}, key());
    expect(cart.updatedAt).toBe("2026-10-08T12:00:00.000Z");
  });
});
```

`packages/adapter-memory/src/conformance.test.ts`:

```ts
import { describeProviderConformance } from "@ace/contracts/testing";
import { MemoryCommerceProvider } from "./memory-provider";
import { memoryFixtures } from "./seed";

describeProviderConformance("memory", async () => ({
  provider: new MemoryCommerceProvider(),
  fixtures: memoryFixtures,
}));
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: FAIL — "declares every capability" fails, the cart tests fail with `NOT_SUPPORTED`, and the conformance cart/checkout tests are skipped or fail.

- [x] **Step 3: Implement carts, checkout and idempotency**

In `packages/adapter-memory/src/memory-provider.ts`:

Replace the import block with:

```ts
import {
  type AddCartLinesInput,
  AddCartLinesInputSchema,
  addMoney,
  type Availability,
  CAPABILITIES,
  type Capability,
  type Cart,
  type CartLine,
  type CheckoutHandoff,
  CommerceError,
  type CommerceProvider,
  type CreateCartInput,
  CreateCartInputSchema,
  GetInventoryInputSchema,
  identityMatches,
  type InventoryLevel,
  type ListOrdersInput,
  ListOrdersInputSchema,
  type ListProductsInput,
  ListProductsInputSchema,
  type ListProductsResult,
  type LookupOrderInput,
  LookupOrderInputSchema,
  MAX_LINE_QUANTITY,
  money,
  multiplyMoney,
  type Order,
  type Product,
  parseInput,
  type SearchProductsInput,
  type SearchProductsResult,
  type UpdateCartLineInput,
  UpdateCartLineInputSchema,
  type Variant,
  type WriteOptions,
  WriteOptionsSchema,
} from "@ace/contracts";
import { decodeCursor, encodeCursor } from "./cursor";
import { searchCatalog } from "./search";
import { defaultSeed, type MemorySeed } from "./seed";
```

Delete `READ_CAPABILITIES` and `notYet`, and add these types under `MemoryProviderOptions`:

```ts
interface StoredLine {
  id: string;
  variantId: string;
  quantity: number;
}

interface StoredCart {
  id: string;
  currency: string;
  attributes: Record<string, string>;
  lines: StoredLine[];
  updatedAt: string;
}
```

Replace the class header and fields with:

```ts
export class MemoryCommerceProvider implements CommerceProvider {
  readonly platform = "memory";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(CAPABILITIES);

  protected readonly seed: MemorySeed;
  protected readonly now: () => Date;
  protected readonly checkoutBaseUrl: string;
  private readonly carts = new Map<string, StoredCart>();
  private readonly idempotentResults = new Map<string, unknown>();
  private nextId = 1;
```

(The constructor stays the same.) Replace the whole `// cart + checkout (Task 8)` section with:

```ts
  // cart + checkout -------------------------------------------------------

  async createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart> {
    return this.once("createCart", "-", opts, () => {
      const query = parseInput(CreateCartInputSchema, input);
      const currency = query.currency ?? this.seed.currency;
      if (currency !== this.seed.currency) {
        throw new CommerceError("INVALID_INPUT", `This store sells in ${this.seed.currency}`, { currency });
      }
      const cart: StoredCart = {
        id: this.newId("cart"),
        currency,
        attributes: query.attributes,
        lines: [],
        updatedAt: this.now().toISOString(),
      };
      this.carts.set(cart.id, cart);
      return this.toCart(cart);
    });
  }

  async getCart(cartId: string): Promise<Cart | null> {
    const cart = this.carts.get(cartId);
    return cart ? this.toCart(cart) : null;
  }

  async addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    return this.once("addCartLines", cartId, opts, () => {
      const query = parseInput(AddCartLinesInputSchema, input);
      const cart = this.requireCart(cartId);
      const next = cart.lines.map((line) => ({ ...line }));
      for (const { variantId, quantity } of query.lines) {
        const { variant } = this.requireVariant(variantId);
        const existing = next.find((line) => line.variantId === variantId);
        const total = (existing?.quantity ?? 0) + quantity;
        if (total > MAX_LINE_QUANTITY) {
          throw new CommerceError("INVALID_INPUT", `At most ${MAX_LINE_QUANTITY} of one item per order`, {
            variantId,
          });
        }
        this.assertInStock(variant, total);
        if (existing) existing.quantity = total;
        else next.push({ id: this.newId("line"), variantId, quantity });
      }
      cart.lines = next;
      cart.updatedAt = this.now().toISOString();
      return this.toCart(cart);
    });
  }

  async updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart> {
    return this.once("updateCartLine", cartId, opts, () => {
      const query = parseInput(UpdateCartLineInputSchema, input);
      const cart = this.requireCart(cartId);
      const line = cart.lines.find((candidate) => candidate.id === query.lineId);
      if (!line) throw new CommerceError("NOT_FOUND", "Cart line not found", { lineId: query.lineId });
      if (query.quantity === 0) {
        cart.lines = cart.lines.filter((candidate) => candidate.id !== query.lineId);
      } else {
        this.assertInStock(this.requireVariant(line.variantId).variant, query.quantity);
        line.quantity = query.quantity;
      }
      cart.updatedAt = this.now().toISOString();
      return this.toCart(cart);
    });
  }

  async createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff> {
    return this.once("createCheckout", cartId, opts, () => {
      const cart = this.requireCart(cartId);
      if (cart.lines.length === 0) throw new CommerceError("CONFLICT", "Cannot check out an empty cart");
      for (const line of cart.lines) this.assertInStock(this.requireVariant(line.variantId).variant, line.quantity);
      return { cartId, url: `${this.checkoutBaseUrl}/${encodeURIComponent(cartId)}`, expiresAt: null };
    });
  }
```

Add these helpers to the `// helpers` section:

```ts
  /** Runs a write once per (operation, target, key); replays return a copy of the first result. */
  private once<T>(operation: string, target: string, opts: WriteOptions, write: () => T): T {
    const { idempotencyKey } = parseInput(WriteOptionsSchema, opts);
    const storageKey = `${operation}:${target}:${idempotencyKey}`;
    if (this.idempotentResults.has(storageKey)) {
      return structuredClone(this.idempotentResults.get(storageKey)) as T;
    }
    const result = write();
    this.idempotentResults.set(storageKey, structuredClone(result));
    return result;
  }

  private newId(prefix: string): string {
    const id = `${prefix}_${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private requireCart(cartId: string): StoredCart {
    const cart = this.carts.get(cartId);
    if (!cart) throw new CommerceError("NOT_FOUND", "Cart not found", { cartId });
    return cart;
  }

  private requireVariant(variantId: string): { product: Product; variant: Variant } {
    for (const product of this.seed.products) {
      const variant = product.variants.find((candidate) => candidate.id === variantId);
      if (variant) return { product, variant };
    }
    throw new CommerceError("NOT_FOUND", "Variant not found", { variantId });
  }

  private assertInStock(variant: Variant, quantity: number): void {
    const available = this.seed.stock[variant.id] ?? 0;
    if (quantity > available) {
      throw new CommerceError("OUT_OF_STOCK", `Only ${available} left of ${variant.title}`, {
        variantId: variant.id,
        available,
      });
    }
  }

  private toCart(cart: StoredCart): Cart {
    const lines: CartLine[] = cart.lines.map((line) => {
      const { product, variant } = this.requireVariant(line.variantId);
      return {
        id: line.id,
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        variantTitle: variant.title,
        quantity: line.quantity,
        unitPrice: { ...variant.price },
        lineTotal: multiplyMoney(variant.price, line.quantity),
        image: product.images[0],
      };
    });
    return {
      id: cart.id,
      currency: cart.currency,
      lines,
      subtotal: lines.reduce((sum, line) => addMoney(sum, line.lineTotal), money(0, cart.currency)),
      itemCount: lines.reduce((count, line) => count + line.quantity, 0),
      attributes: { ...cart.attributes },
      updatedAt: cart.updatedAt,
    };
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ace/adapter-memory test`
Expected: PASS — 4 files. The conformance suite reports **19 passed, 0 skipped**.

- [x] **Step 5: Run the whole workspace**

Run: `pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green across both packages.

- [x] **Step 6: Commit**

```bash
git add packages/adapter-memory
git commit -m "feat(adapter-memory): add carts, checkout and idempotency; pass full conformance suite"
```

---

### Task 9: Continuous integration and repository README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: root scripts `lint`, `typecheck`, `test` (Task 1).
- Produces: a CI check named `check` that must pass on every pull request.

- [x] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [x] **Step 2: Write the README**

`README.md`:

````markdown
# AI Commerce Engine (ACE)

A multi-tenant AI sales and support assistant for online stores. The agent talks to a universal commerce contract;
each store platform plugs in through an adapter.

- Rules for contributors and AI agents: [AGENTS.md](AGENTS.md)
- How the system works end to end: [docs/workflow.md](docs/workflow.md)
- Design: [docs/superpowers/specs/2026-10-08-ai-commerce-engine-design.md](docs/superpowers/specs/2026-10-08-ai-commerce-engine-design.md)
- Roadmap: [docs/superpowers/plans/2026-10-08-roadmap.md](docs/superpowers/plans/2026-10-08-roadmap.md)

## Quick start

```bash
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## Packages

| Package | Purpose |
|---|---|
| `@ace/contracts` | Commerce contract: schemas, `CommerceProvider`, errors, capabilities, conformance suite |
| `@ace/adapter-memory` | In-memory LKR clothing store used by tests, evals and local development |
````

- [x] **Step 3: Verify locally exactly what CI runs**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`
Expected: all succeed.

- [x] **Step 4: Commit**

```bash
git add .github README.md
git commit -m "ci: add lint, typecheck and test workflow; docs: add README"
```

---

## Phase 1 exit checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` green locally and in CI — pending first push
- [x] Memory adapter: conformance suite 20 passed, 1 skipped (the NOT_SUPPORTED probe skips because the memory adapter declares every capability; suite extended per controller ruling R6).
- [x] Every Review Focus item has a passing test (Tasks 1, 6, 7, 8).
- [x] ADR-001 committed.
- [x] `AGENTS.md` "Commands" section matches the real scripts.
- [x] Next: write the Phase 2 (agent core) plan from the roadmap.
