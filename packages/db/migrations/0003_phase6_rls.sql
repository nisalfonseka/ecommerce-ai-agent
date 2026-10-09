-- Phase 6 tenancy (ADR-005): same policy as 0001_rls.sql on the new tables, plus the definer functions for
-- the three reads that happen before a tenant is known. Functions return routing data only.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  catalog_products, catalog_variants, catalog_sync_state, knowledge_documents, knowledge_chunks,
  webhook_events, attributed_orders
  TO ace_app;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog_products', 'catalog_variants', 'catalog_sync_state', 'knowledge_documents', 'knowledge_chunks',
    'webhook_events', 'attributed_orders'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- The definer functions read stores and tenants, which are FORCE RLS. A function owned by the migration owner
-- would see zero rows whenever that owner is neither a superuser nor BYPASSRLS (the production posture).
-- So they get a dedicated owner role: no superuser, no BYPASSRLS, column-level SELECT, and a permissive
-- read policy that applies to this role only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ace_router') THEN
    CREATE ROLE ace_router NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ace_router;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, config, webhook_secret_sealed) ON stores TO ace_router;
--> statement-breakpoint
GRANT SELECT (id, status) ON tenants TO ace_router;
--> statement-breakpoint
CREATE POLICY router_read ON stores FOR SELECT TO ace_router USING (true);
--> statement-breakpoint
CREATE POLICY router_read ON tenants FOR SELECT TO ace_router USING (true);
--> statement-breakpoint
-- ALTER FUNCTION ... OWNER TO needs membership (with SET) in the new owner and CREATE on the schema; the
-- schema privilege is revoked again right after the hand-over.
GRANT ace_router TO current_user WITH SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO ace_router;
--> statement-breakpoint
CREATE FUNCTION resolve_webhook_store(p_store_id uuid)
RETURNS TABLE (tenant_id uuid, webhook_secret_sealed bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id, s.webhook_secret_sealed FROM stores s WHERE s.id = p_store_id
$$;
--> statement-breakpoint
CREATE FUNCTION list_sync_targets()
RETURNS TABLE (tenant_id uuid, store_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id, s.id FROM stores s
  JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
  WHERE s.config -> 'search' ->> 'mode' = 'index'
$$;
--> statement-breakpoint
CREATE FUNCTION list_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT id FROM tenants $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_webhook_store(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_sync_targets() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_tenant_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_webhook_store(uuid) TO ace_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_sync_targets() TO ace_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_tenant_ids() TO ace_app;
--> statement-breakpoint
ALTER FUNCTION resolve_webhook_store(uuid) OWNER TO ace_router;
--> statement-breakpoint
ALTER FUNCTION list_sync_targets() OWNER TO ace_router;
--> statement-breakpoint
ALTER FUNCTION list_tenant_ids() OWNER TO ace_router;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM ace_router;
