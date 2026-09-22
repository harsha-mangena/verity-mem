-- 0015_claim_entity_index.sql
--
-- `entity_aliases` is a dictionary (alias -> canonical), not an inverted index.
-- The old entity channel joined that dictionary to every claim in a tenant with:
--
--   canonical = subject OR canonical = lower(object::text)
--
-- The OR prevented a useful index path, `jsonb::text` retained quotes around JSON
-- strings, and a matching alias could therefore drive a tenant-wide claims scan
-- under RLS. Keep the dictionary, but add the missing canonical -> claim projection.
-- Entity retrieval now starts with a handful of aliases and performs primary-key
-- claim lookups rather than searching the claim population for each alias.

CREATE TABLE claim_entities (
  tenant_id UUID NOT NULL,
  canonical TEXT NOT NULL,
  claim_id  UUID NOT NULL REFERENCES claims(claim_id),
  source    TEXT NOT NULL,
  confidence REAL
);

-- Backfill the projection for claims that can participate in the current entity
-- retrieval path. JSON string extraction uses #>> rather than ::text so the
-- canonical value is `alice`, not the quoted JSON literal `"alice"`.
INSERT INTO claim_entities (tenant_id, canonical, claim_id, source, confidence)
SELECT tenant_id, lower(btrim(subject)), claim_id, 'migration_backfill', 1.0
 FROM claims
 WHERE status IN ('accepted', 'disputed')
   AND btrim(subject) <> '';

INSERT INTO claim_entities (tenant_id, canonical, claim_id, source, confidence)
SELECT tenant_id, lower(btrim(object #>> '{}')), claim_id, 'migration_backfill', 1.0
  FROM claims
 WHERE status IN ('accepted', 'disputed')
   AND jsonb_typeof(object) = 'string'
   AND btrim(object #>> '{}') <> ''
   AND length(object #>> '{}') <= 200
   -- Avoid the one possible duplicate without maintaining a unique index during
   -- the bulk load. Building the primary key once after backfill is substantially
   -- cheaper on a million-claim database than two million indexed inserts.
   AND lower(btrim(object #>> '{}')) <> lower(btrim(subject));

ALTER TABLE claim_entities
  ADD CONSTRAINT claim_entities_pkey PRIMARY KEY (tenant_id, canonical, claim_id);
CREATE INDEX claim_entities_claim_idx ON claim_entities (claim_id);

ALTER TABLE claim_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY claim_entities_authorized ON claim_entities
  USING (
    COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE)
    AND EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_entities.claim_id)
  )
  WITH CHECK (
    COALESCE(tenant_id = veritymem.current_tenant_id(), FALSE)
    AND EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = claim_entities.claim_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON claim_entities TO veritymem_app;

-- The dense join, projection-version check and watermark lookup all filter by
-- tenant. These exact indexes let PostgreSQL establish that boundary before the
-- more expensive vector/join work, and make max(seq) an index-edge lookup rather
-- than a tenant scan.
CREATE INDEX claim_embeddings_tenant_model_idx
  ON claim_embeddings (tenant_id, model_id, claim_id);
CREATE INDEX events_tenant_seq_desc_idx
  ON events (tenant_id, seq DESC);
CREATE INDEX claims_current_tenant_scope_idx
  ON claims (tenant_id, scope_id, claim_id)
  WHERE valid_to IS NULL AND status = 'accepted';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'claim_entities' AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'self-check failed: claim_entities does not enforce row-level security';
  END IF;
END
$$;
