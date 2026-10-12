-- Phase 7 tenancy (ADR-005): same policy as 0001_rls.sql / 0003_phase6_rls.sql on the new tables. None of
-- them is read before a tenant is known: a staff token carries its tenant id (st_<tenantId>.<secret>), so
-- the engine looks the hash up inside withTenant and no definer function or routing copy is needed.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant_settings, verifications, consents, handoffs, staff_tokens, privacy_requests
  TO ace_app;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings', 'verifications', 'consents', 'handoffs', 'staff_tokens', 'privacy_requests'
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
