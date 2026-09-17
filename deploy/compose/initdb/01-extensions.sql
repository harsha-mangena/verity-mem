-- Runs once, as the superuser, before any migration.
-- Extensions that require elevated privileges live here rather than in migrations.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- The application connects as this role. It is deliberately NOT a superuser and
-- does NOT have BYPASSRLS, so row-level security is a real backstop for it and
-- not a no-op that quietly passes every test.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'veritymem_app') THEN
    CREATE ROLE veritymem_app LOGIN PASSWORD 'veritymem_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE veritymem TO veritymem_app;
GRANT USAGE ON SCHEMA public TO veritymem_app;
