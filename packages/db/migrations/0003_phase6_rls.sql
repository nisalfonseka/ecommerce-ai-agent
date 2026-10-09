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
