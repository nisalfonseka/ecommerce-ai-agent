# Reference store

The first client store (ADR-006): a generic Sri Lankan clothing shop on **Medusa v2** with LKR prices, island-wide
flat delivery, PayHere card payments and cash on delivery. `@ace/adapter-medusa` is tested against it.

This is a standalone npm project, outside the pnpm workspace and Turborepo (ADR-006).

```bash
scripts/reference-store.sh start   # Postgres → create + migrate + seed once → backend on http://localhost:9000
scripts/reference-store.sh reset   # drop the database and seed again (new keys)
scripts/reference-store.sh stop
```

The seed writes the publishable key, the secret key and the conformance fixture IDs to
`${TMPDIR:-/tmp}/ace-store/seed-output.json` (mode 600). Never commit it.

- `backend/` — Medusa config, seed (`src/scripts/seed.ts`, catalog in `catalog.ts`), PayHere provider, order webhooks
- `storefront/` — Next.js storefront: catalog, product, cart, checkout (cash on delivery or PayHere), `/cart/adopt`
  for the assistant's checkout handoff, and the assistant widget sharing the site's cart

```bash
scripts/store-stack.sh start                           # Medusa + engine (demo model) + storefront on http://localhost:8000
(cd apps/reference-store/storefront && npm run e2e)    # end to end in Chromium (CHROME_PATH for a local Chromium)
```
