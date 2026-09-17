-- 0001_core.sql — VerityMem canonical schema.
--
-- There is no `memory` table. Evidence, candidates, claims and decisions are
-- separate objects with separate lifecycles, and only `events` is immutable.
--
-- Everything here is additive: migrations are never destructive, because a
-- destructive migration against an append-only ledger is a contradiction.

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

CREATE TYPE origin_kind AS ENUM
  ('user','agent','tool','document','database','model_inference');

CREATE TYPE authority_cls AS ENUM
  ('verified_record','observation','user_self_report','hearsay','inference');

CREATE TYPE claim_status AS ENUM
  ('proposed','accepted','disputed','superseded','rejected','revoked','expired');

CREATE TYPE claim_kind AS ENUM
  ('observation','user_self_report','preference','event','decision',
   'plan','hypothesis','procedure','permission','derived_summary');

CREATE TYPE decision_outcome AS ENUM
  ('accept','accept_limited_scope','needs_review','quarantine','reject','revoke');

CREATE TYPE relation_kind AS ENUM
  ('duplicates','narrows','contradicts','supersedes','derived_from');

CREATE TYPE evidence_role AS ENUM ('supports','refutes');

CREATE TYPE candidate_state AS ENUM
  ('pending','extracted','validated','gated','failed');

CREATE TYPE retention_mode AS ENUM ('erase','redact','export_then_erase');

CREATE TYPE retention_state AS ENUM
  ('pending','running','scanning','verified','failed');

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  tenant_id  UUID PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  tenant_id    UUID NOT NULL,
  principal_id TEXT NOT NULL,
  kind         origin_kind NOT NULL,
  issuer       TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, principal_id)
);

-- Explicit ownership boundary. Purpose is first-class, not a tag: a claim
-- admitted for release_planning is not thereby available for hr_review.
CREATE TABLE scopes (
  scope_id   UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL,
  project    TEXT,
  user_id    TEXT,
  agent_id   TEXT,
  session_id TEXT,
  purpose    TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A scope must bind at least one dimension. A scope with no dimension is a
  -- tenant-wide scope in disguise, and tenant-wide scopes are how accidental
  -- disclosure happens.
  CONSTRAINT scopes_must_bind_something CHECK (
    project IS NOT NULL OR user_id IS NOT NULL
    OR agent_id IS NOT NULL OR session_id IS NOT NULL
  )
);

CREATE INDEX scopes_lookup_idx ON scopes (tenant_id, project, user_id, agent_id, session_id);

-- ---------------------------------------------------------------------------
-- Immutable source of truth
-- ---------------------------------------------------------------------------

CREATE TABLE streams (
  stream_id TEXT NOT NULL,
  tenant_id UUID NOT NULL,
  last_seq  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, stream_id)
);

CREATE TABLE events (
  event_id     UUID PRIMARY KEY,
  stream_id    TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  tenant_id    UUID NOT NULL,
  scope_id     UUID NOT NULL REFERENCES scopes(scope_id),
  origin       origin_kind NOT NULL,
  actor_id     TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,                    -- valid-time anchor
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),       -- transaction-time
  payload      TEXT,                                     -- inline for small bodies
  payload_ref  TEXT,                                     -- content-addressed blob otherwise
  content_hash BYTEA NOT NULL,
  prev_hash    BYTEA,                                    -- optional chaining
  chained      BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity  TEXT NOT NULL DEFAULT 'normal',
  idempotency_key TEXT,
  media_type   TEXT NOT NULL DEFAULT 'text/plain',
  byte_length  INT NOT NULL,
  redacted_at  TIMESTAMPTZ,                              -- set by /v1/forget erase
  UNIQUE (tenant_id, stream_id, seq),
  UNIQUE (tenant_id, idempotency_key),
  -- Exactly one payload holding place. Both set, or neither, is a bug.
  CONSTRAINT events_payload_present CHECK (
    (payload IS NOT NULL AND payload_ref IS NULL)
    OR (payload IS NULL AND payload_ref IS NOT NULL)
    OR redacted_at IS NOT NULL
  )
);

CREATE INDEX events_stream_idx   ON events (tenant_id, stream_id, seq);
CREATE INDEX events_recorded_idx ON events (tenant_id, recorded_at);
CREATE INDEX events_scope_idx    ON events (scope_id);
CREATE INDEX events_actor_idx    ON events (tenant_id, actor_id, occurred_at DESC);

-- The exact bytes supporting a claim. Offsets are half-open [start_off, end_off)
-- into the event payload, and span_digest detects payload drift independently of
-- the content hash: a span must never silently point at different text.
CREATE TABLE evidence_spans (
  span_id     UUID PRIMARY KEY,
  event_id    UUID NOT NULL REFERENCES events(event_id),
  start_off   INT NOT NULL,
  end_off     INT NOT NULL,
  selector    TEXT,
  span_digest BYTEA NOT NULL,
  quote       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_off > start_off),
  CHECK (start_off >= 0)
);

CREATE INDEX evidence_spans_event_idx ON evidence_spans (event_id);
CREATE UNIQUE INDEX evidence_spans_identity_idx
  ON evidence_spans (event_id, start_off, end_off, COALESCE(selector, ''));

-- ---------------------------------------------------------------------------
-- Untrusted proposals
-- ---------------------------------------------------------------------------

CREATE TABLE claim_candidates (
  candidate_id    UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  source_event_id UUID NOT NULL REFERENCES events(event_id),
  kind            claim_kind NOT NULL,
  subject         TEXT NOT NULL,
  predicate       TEXT NOT NULL,
  object          JSONB NOT NULL,
  requested_scope UUID NOT NULL REFERENCES scopes(scope_id),
  extractor       TEXT NOT NULL,           -- name@version
  model_version   TEXT,
  prompt_version  TEXT,
  confidence      REAL,                    -- extractor confidence, never merged
  state           candidate_state NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX claim_candidates_event_idx  ON claim_candidates (source_event_id);
CREATE INDEX claim_candidates_state_idx  ON claim_candidates (tenant_id, state, created_at);
CREATE INDEX claim_candidates_lookup_idx ON claim_candidates (tenant_id, subject, predicate);

CREATE TABLE candidate_evidence (
  candidate_id UUID NOT NULL REFERENCES claim_candidates(candidate_id),
  span_id      UUID NOT NULL REFERENCES evidence_spans(span_id),
  role         evidence_role NOT NULL,
  PRIMARY KEY (candidate_id, span_id)
);

-- ---------------------------------------------------------------------------
-- Believed state
-- ---------------------------------------------------------------------------

CREATE TABLE claims (
  claim_id    UUID PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  scope_id    UUID NOT NULL REFERENCES scopes(scope_id),
  kind        claim_kind NOT NULL,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      JSONB NOT NULL,
  status      claim_status NOT NULL,
  authority   authority_cls NOT NULL,
  valid_from  TIMESTAMPTZ NOT NULL,
  valid_to    TIMESTAMPTZ,                            -- NULL = currently believed
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),      -- transaction-time start
  expires_at  TIMESTAMPTZ,
  origin_event_id UUID REFERENCES events(event_id),
  extractor   TEXT,
  model_version TEXT,
  prompt_version TEXT,
  -- Maintained by trigger so the valid-time interval can never drift from the
  -- columns. [) semantics: valid_to is exclusive.
  valid_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED,
  -- Lexical projection. Rebuilt by projection code; never authoritative.
  search_tsv  TSVECTOR,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX claims_current_idx
  ON claims (tenant_id, subject, predicate) WHERE valid_to IS NULL AND status = 'accepted';
CREATE INDEX claims_scope_idx    ON claims (scope_id);
CREATE INDEX claims_valid_gist   ON claims USING GIST (valid_range);
CREATE INDEX claims_recorded_idx ON claims (tenant_id, recorded_at);
CREATE INDEX claims_status_idx   ON claims (tenant_id, status, kind);
CREATE INDEX claims_object_gin   ON claims USING GIN (object jsonb_path_ops);
CREATE INDEX claims_tsv_gin      ON claims USING GIN (search_tsv);
CREATE INDEX claims_event_idx    ON claims (origin_event_id);

CREATE TABLE claim_evidence (
  claim_id UUID NOT NULL REFERENCES claims(claim_id),
  span_id  UUID NOT NULL REFERENCES evidence_spans(span_id),
  role     evidence_role NOT NULL,
  PRIMARY KEY (claim_id, span_id)
);

-- Contradiction is explicit, never inferred from adjacency or timestamp order.
CREATE TABLE claim_relations (
  from_claim   UUID NOT NULL REFERENCES claims(claim_id),
  to_claim     UUID NOT NULL REFERENCES claims(claim_id),
  rel          relation_kind NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_claim, to_claim, rel),
  CHECK (from_claim <> to_claim)
);

CREATE INDEX claim_relations_to_idx ON claim_relations (to_claim, rel);

-- Every promotion is a recorded, versioned act.
CREATE TABLE decisions (
  decision_id   UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  candidate_id  UUID REFERENCES claim_candidates(candidate_id),
  claim_id      UUID REFERENCES claims(claim_id),
  policy_version TEXT NOT NULL,
  outcome       decision_outcome NOT NULL,
  reason_codes  TEXT[] NOT NULL,
  approver      TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (candidate_id IS NOT NULL OR claim_id IS NOT NULL)
);

CREATE INDEX decisions_candidate_idx ON decisions (candidate_id);
CREATE INDEX decisions_claim_idx     ON decisions (claim_id, decided_at);
CREATE INDEX decisions_tenant_idx    ON decisions (tenant_id, decided_at DESC);
-- Reason codes drive the review-burden metric, so make them queryable.
CREATE INDEX decisions_reasons_gin   ON decisions USING GIN (reason_codes);

CREATE TABLE grants (
  grant_id         UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL,
  subject          TEXT NOT NULL,          -- principal or group receiving access
  resource_pattern TEXT NOT NULL,          -- scope selector pattern
  actions          TEXT[] NOT NULL,
  purpose          TEXT[] NOT NULL,
  matrix           JSONB NOT NULL,         -- parsed pattern: project/user/agent/purpose dims
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ
);

CREATE INDEX grants_subject_idx ON grants (tenant_id, subject);

-- ---------------------------------------------------------------------------
-- Rebuild and drift tracking
-- ---------------------------------------------------------------------------

CREATE TABLE projection_versions (
  projection       TEXT PRIMARY KEY,
  code_version     TEXT NOT NULL,
  model_version    TEXT,
  model_sha256     TEXT,
  prompt_version   TEXT,
  ledger_watermark BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE query_traces (
  trace_id              UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  caller                TEXT NOT NULL,
  query                 JSONB NOT NULL,
  policy_version        TEXT NOT NULL,
  resolved_scope_ids    UUID[] NOT NULL,
  candidates            JSONB NOT NULL,
  returned              JSONB NOT NULL,
  projection_watermark  BIGINT NOT NULL,
  model_calls           INT NOT NULL DEFAULT 0,
  latency_ms            INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX query_traces_tenant_idx ON query_traces (tenant_id, created_at DESC);

CREATE TABLE retention_jobs (
  job_id          UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  subject_or_scope JSONB NOT NULL,
  mode            retention_mode NOT NULL,
  reason          TEXT NOT NULL,
  status          retention_state NOT NULL DEFAULT 'pending',
  stores_touched  TEXT[] NOT NULL DEFAULT '{}',
  manifest        JSONB NOT NULL DEFAULT '{}'::jsonb,
  residual_matches INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at     TIMESTAMPTZ
);

CREATE INDEX retention_jobs_tenant_idx ON retention_jobs (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Disposable projections
-- ---------------------------------------------------------------------------

CREATE TABLE claim_embeddings (
  claim_id   UUID PRIMARY KEY REFERENCES claims(claim_id),
  tenant_id  UUID NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  model_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW is chosen over IVFFlat because the corpus grows continuously and
-- IVFFlat needs a training pass that a rebuild-heavy projection cannot rely on.
CREATE INDEX claim_embeddings_hnsw_idx
  ON claim_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE entity_aliases (
  tenant_id   UUID NOT NULL,
  alias       TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  source      TEXT NOT NULL,
  confidence  REAL,
  PRIMARY KEY (tenant_id, alias, canonical)
);

CREATE INDEX entity_aliases_canonical_idx ON entity_aliases (tenant_id, canonical);

-- ---------------------------------------------------------------------------
-- Async spine: the ledger is already the event source, so the outbox lives in
-- the same database rather than behind a second broker.
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  outbox_id    BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 8,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending_idx
  ON outbox (available_at, outbox_id) WHERE completed_at IS NULL;
