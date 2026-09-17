-- 0004_event_delete_guard.sql
--
-- `reject_event_mutation` is a row-level trigger, so PostgreSQL does not run it
-- for a DELETE that matches zero rows. That is usually irrelevant — deleting
-- nothing changes nothing — but it means a DELETE without a WHERE clause would
-- succeed while a targeted DELETE would fail, which is the wrong way round for a
-- guard. A statement-level DELETE trigger always fires.

CREATE OR REPLACE FUNCTION veritymem.reject_event_delete() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: DELETE is not permitted (statement-level guard)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER events_no_delete
  BEFORE DELETE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION veritymem.reject_event_delete();
