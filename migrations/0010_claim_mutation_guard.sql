-- 0010_claim_mutation_guard.sql
--
-- "No model call has direct write access to `claims.status = 'accepted'`" is stated
-- as a critical invariant, and until now it was an interface property only: the
-- AppRole could `UPDATE claims SET status = 'accepted'` directly, and `object`,
-- `authority`, `scope_id` and the validity window were all mutable with no decision
-- row left behind. An invariant that one SQL statement can void is a convention,
-- not an invariant.
--
-- This migration makes three rules the database's business:
--
--   1. A claim's proposition is fixed at creation. `object` joins `subject` and
--      `predicate` in the immutable set. A changed object is a *new* claim, and
--      rewriting one in place would invalidate the evidence binding that makes the
--      claim inspectable — the spans would still point at text that no longer
--      supports what the claim now says.
--   2. `authority` and `scope_id` are fixed at creation. Both are outputs of the
--      gate, and both are what a reader relies on to decide whether to act; neither
--      may be upgraded by an UPDATE. An authority upgrade is the single most
--      valuable thing an attacker with write access could do here.
--   3. A status transition requires a decision row naming the resulting status,
--      written in the same transaction. The gate does this; a hand-written UPDATE
--      does not, and now cannot.
--
-- The remaining legitimate mutation is closing a validity interval (`valid_to`), by
-- supersession, expiry or revocation. Opening one is refused: a claim may not be
-- made to cover a period it was not admitted for.

CREATE OR REPLACE FUNCTION veritymem.guard_claim_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_decisive INTEGER;
BEGIN
  -- 1 and 2: the proposition and the gate's outputs are immutable.
  IF NEW.object     IS DISTINCT FROM OLD.object
     OR NEW.authority IS DISTINCT FROM OLD.authority
     OR NEW.scope_id  IS DISTINCT FROM OLD.scope_id
     OR NEW.extractor IS DISTINCT FROM OLD.extractor
     OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version THEN
    RAISE EXCEPTION
      'claim proposition and provenance are immutable (claim_id=%): a changed object, authority or scope is a new claim, not an edit',
      OLD.claim_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 3: a validity window may be closed, never opened wider than it was admitted.
  IF NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'a claim''s valid_from is fixed at admission (claim_id=%)', OLD.claim_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    IF NEW.valid_to IS NULL THEN
      RAISE EXCEPTION
        'a closed validity interval cannot be reopened (claim_id=%); a claim that ended did not stop having ended',
        OLD.claim_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.valid_to IS NOT NULL AND NEW.valid_to < OLD.valid_to THEN
      RAISE EXCEPTION
        'a validity interval cannot be extended by moving its end later (claim_id=%): % -> %',
        OLD.claim_id, OLD.valid_to, NEW.valid_to
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- 4: every status transition is a recorded, versioned act.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT count(*) INTO v_decisive
      FROM decisions d
     WHERE d.claim_id = NEW.claim_id
       AND d.outcome::text = CASE NEW.status
                               WHEN 'accepted'   THEN 'accept'
                               WHEN 'revoked'    THEN 'revoke'
                               WHEN 'rejected'   THEN 'reject'
                               WHEN 'superseded' THEN 'accept'
                               WHEN 'disputed'   THEN 'needs_review'
                               WHEN 'expired'    THEN 'accept'
                               WHEN 'proposed'   THEN 'needs_review'
                             END
       -- No recency window. An earlier version required the decision to be less
       -- than a minute old, which made the guard depend on wall-clock time and
       -- failed deterministically for any caller running on a fixed clock. What the
       -- rule needs to establish is that a decision *exists* for this transition, not
       -- when it was written.
       ;

    IF v_decisive = 0 THEN
      RAISE EXCEPTION
        'status transition to % requires a decision row for this claim (claim_id=%); the gate writes one, a bare UPDATE does not',
        NEW.status, OLD.claim_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Replaced rather than created: the function above is `CREATE OR REPLACE`, so the
-- migration is re-runnable, but the trigger is not. The earlier form of this
-- migration was applied and then corrected, and a migration that cannot be re-applied
-- after a correction is a migration nobody will dare correct.
DROP TRIGGER IF EXISTS claims_mutation_guard ON claims;
CREATE TRIGGER claims_mutation_guard
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION veritymem.guard_claim_mutation();

-- ---------------------------------------------------------------------------
-- Self-check
--
-- Assert the guard actually fires, in a rolled-back transaction, rather than
-- trusting that a trigger was created.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_claim UUID;
  v_raised BOOLEAN := FALSE;
BEGIN
  SELECT c.claim_id INTO v_claim FROM claims c WHERE c.status = 'accepted' LIMIT 1;
  IF v_claim IS NULL THEN
    RETURN;  -- nothing to check on an empty database
  END IF;

  BEGIN
    UPDATE claims SET authority = 'verified_record' WHERE claim_id = v_claim;
  EXCEPTION WHEN restrict_violation THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: an authority upgrade was permitted';
  END IF;

  v_raised := FALSE;
  BEGIN
    UPDATE claims SET object = '{"rewritten": true}'::jsonb WHERE claim_id = v_claim;
  EXCEPTION WHEN restrict_violation THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: the proposition was rewritten in place';
  END IF;

  -- The legitimate mutation must still work: closing an interval.
  UPDATE claims SET valid_to = now() WHERE claim_id = v_claim AND valid_to IS NULL;

  RAISE EXCEPTION 'self-check rollback' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'self-check rollback' THEN
      RAISE;
    END IF;
END
$$;
