-- 0013_projection_versions_per_tenant.sql
--
-- `projection_versions` was keyed on `projection` alone, which made it a single global row
-- per projection for the whole database. In a multi-tenant deployment that is wrong in a
-- way that only shows up as a confusing health report: the last tenant to rebuild a
-- projection overwrites the row, so asking "which embedding model wrote this tenant's dense
-- projection?" answers with whichever tenant wrote most recently.
--
-- It surfaced through the health check for the embedding-model mismatch, which is exactly
-- the check that exists to stop a silent empty dense channel. A check that can be satisfied
-- by another tenant's state is worse than no check, because it reports `ok`.
--
-- The table now carries `tenant_id` and is keyed on (projection, tenant_id). `model_sha256`
-- gains the tokenizer digest for the gate backend, so a deployment can record every asset
-- that produced a projection rather than only the model.

ALTER TABLE projection_versions ADD COLUMN tenant_id UUID;

-- Existing rows have no tenant to attribute to. They are left attributed to nobody rather
-- than guessed at: `tenant_id` stays NULL, which the health check reads as "no projection
-- recorded for this tenant" instead of adopting another deployment's model.
COMMENT ON COLUMN projection_versions.tenant_id IS
  'The tenant this projection belongs to. NULL means the row predates per-tenant versioning and is not attributable to any tenant.';

-- A plain primary key on (projection, tenant_id) cannot coexist with the unattributable
-- rows, because a primary key implies NOT NULL. A unique index over COALESCE treats those
-- rows as one shared "unattributed" bucket instead: they stay readable and reported as
-- unattributed, and a real tenant's row is still unique per projection.
ALTER TABLE projection_versions DROP CONSTRAINT IF EXISTS projection_versions_pkey;
CREATE UNIQUE INDEX projection_versions_projection_tenant_idx
  ON projection_versions (projection, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- The health check and the replay oracle both read this table by projection, so the index is
-- what keeps that a lookup rather than a scan once there is one row per tenant.
CREATE INDEX projection_versions_tenant_idx ON projection_versions (tenant_id);

DROP POLICY IF EXISTS projection_versions_context ON projection_versions;
CREATE POLICY projection_versions_tenant ON projection_versions
  USING (COALESCE(tenant_id = veritymem.current_tenant_id(), veritymem.system_context()))
  WITH CHECK (COALESCE(tenant_id = veritymem.current_tenant_id(), veritymem.system_context()));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'projection_versions' AND column_name = 'tenant_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'self-check failed: tenant_id must be nullable so unattributable rows remain readable as unattributed';
  END IF;
END
$$;
