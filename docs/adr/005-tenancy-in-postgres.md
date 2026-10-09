# ADR-005: Tenant isolation in Postgres

- Status: Accepted (2026-10-09). Implementation: Phase 3 Task 2 (`packages/db`).

## Context

Every tenant's data lives in one Postgres database (AGENTS.md rule 13). A missed `WHERE tenant_id = …` in application code must not leak another merchant's conversations. The engine also has to find the tenant from a publishable widget key before it knows which tenant it is serving.

## Decision

- **Two roles.** Migrations run as the database owner. The engine connects as `ace_app` (`NOSUPERUSER NOBYPASSRLS`, DML only, created by the migration and given its password by `runMigrations`). In production the owner is a non-superuser role, because superusers bypass RLS even when it is forced.
- **Forced RLS on every tenant table**, with one policy `tenant_isolation`:
  `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` (`id` for `tenants`), for both `USING` and `WITH CHECK`. If the setting is missing, it reads as `NULL`. After a transaction-local `set_config` on a pooled connection, it reads as `''`, and `nullif` maps that to `NULL` too, so nothing matches.
- **`withTenant(db, tenantId, fn)`** is the only way to touch tenant data. It validates the UUID, opens a transaction, runs `set_config('app.tenant_id', $1, true)` (transaction-local, so it cannot leak to the next borrower of the connection) and runs `fn`.
- **Widget-key lookup.** `widget_key_lookup` is a routing copy of `widget_keys` (key hash → tenant, bot, origins, revoked). It has no RLS and no grant to `ace_app`. Two owner-rights functions handle it: a trigger on `widget_keys` keeps it in sync, and `resolve_widget_key(hash)` reads it. Because `widget_keys` writes are themselves RLS-checked, a tenant can register or revoke only its own keys.
- **Proof.** `packages/db/src/rls.test.ts` runs as `ace_app` against real Postgres in CI. It checks that each tenant sees only its own rows in every table listed in `TENANT_TABLES`, that cross-tenant writes fail, that nothing is visible outside `withTenant`, and that a pooled connection does not carry the tenant over.

## Consequences

- New tenant tables must be added to `TENANT_TABLES` and to the RLS migration; the RLS test then covers them automatically.
- Cross-tenant work (admin reports, the Phase 6 worker) needs an explicit design: per-tenant loops through `withTenant`, or a dedicated definer function. Never a `BYPASSRLS` role in the engine.
- Each request costs one extra statement (`set_config`) per transaction, which is negligible.
