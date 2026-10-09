-- Tenancy (ADR-005). Hand-written: drizzle-kit does not emit roles, FORCE RLS or definer functions.
-- The engine connects as ace_app (no superuser, no BYPASSRLS). Every tenant row is visible only when the
-- transaction-local setting app.tenant_id matches. Unset reads as NULL, and after a transaction-local
-- set_config it reads as '' on that connection; nullif() maps both to NULL, which matches nothing.
-- FORCE makes the policies bind the table owner too (superusers still bypass RLS; production runs
-- migrations as a non-superuser owner).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ace_app') THEN
    CREATE ROLE ace_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION
  -- Roles are cluster-wide; parallel migrations of different databases may race here.
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ace_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, stores, bots, widget_keys, conversations, messages, tool_calls, turn_traces, usage_ledger,
  idempotency_records
  TO ace_app;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores', 'bots', 'widget_keys', 'conversations', 'messages', 'tool_calls', 'turn_traces',
    'usage_ledger', 'idempotency_records'
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
-- widget_key_lookup: no RLS, no grant to ace_app. The one pre-tenant read goes through this function, which
-- runs with the owner's rights and returns routing data only.
REVOKE ALL ON widget_key_lookup FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION resolve_widget_key(p_key_hash text)
RETURNS TABLE (tenant_id uuid, bot_id uuid, allowed_origins text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.tenant_id, l.bot_id, l.allowed_origins
  FROM widget_key_lookup l
  WHERE l.key_hash = p_key_hash AND l.revoked_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_widget_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_widget_key(text) TO ace_app;
--> statement-breakpoint
-- Keep the lookup in sync with widget_keys. The trigger runs with the owner's rights; widget_keys writes are
-- themselves RLS-checked, so a tenant can only register or revoke its own keys.
CREATE FUNCTION sync_widget_key_lookup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM widget_key_lookup WHERE key_hash = OLD.key_hash;
    RETURN OLD;
  END IF;
  INSERT INTO widget_key_lookup (key_hash, tenant_id, bot_id, allowed_origins, revoked_at)
  VALUES (NEW.key_hash, NEW.tenant_id, NEW.bot_id, NEW.allowed_origins, NEW.revoked_at)
  ON CONFLICT (key_hash) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, bot_id = EXCLUDED.bot_id,
        allowed_origins = EXCLUDED.allowed_origins, revoked_at = EXCLUDED.revoked_at;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sync_widget_key_lookup() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER widget_keys_sync_lookup
  AFTER INSERT OR UPDATE OR DELETE ON widget_keys
  FOR EACH ROW EXECUTE FUNCTION sync_widget_key_lookup();
