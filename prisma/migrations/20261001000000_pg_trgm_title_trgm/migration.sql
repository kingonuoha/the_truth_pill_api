-- Phase 05 / A3 / DEV-008 — install `pg_trgm` and the fuzzy-title GIN index.
--
-- This closes the gap Phase 01 shipped without: `20260929000000_articles_search`
-- built the tsvector trigger + `articles_searchVector_idx` but NOT the
-- `pg_trgm` extension or `articles_title_trgm` (phase-01/checks.md §6.2/§6.3
-- recorded both as failing). `docs/phases/phase-00/data-migration-findings.md`
-- §7.1 specifies exactly these two statements.
--
-- WHY HAND-WRITTEN: Prisma cannot express an operator class
-- (`gin_trgm_ops`) in `@@index`, so this DDL lives in SQL only — the same
-- permanent-drift policy already documented for `articles_searchVector_idx`
-- (see the `searchVector` comment in schema.prisma). `migrate diff` will not
-- ask for this index because the schema deliberately does not declare it.
--
-- WHY NO SLUG TRGM INDEX (decision, per the DEV-008 §7.2 design question):
-- the `slug` +50 rule is a substring containment evaluated per-row inside the
-- ranked scorer's CASE sum over the candidate set — it is not a WHERE-level
-- narrowing predicate, so a GIN trgm index on `slug` would not be used by the
-- scorer. Corpus is 132 published articles; the containment is a trivial scan.
-- Adding an index the query plan cannot use is exactly the speculative write
-- cost this migration exists to remove. If the backend's query shape (A4
-- candidate-set decision) later filters on slug containment at scale, a
-- follow-up migration adds `articles_slug_trgm`. Documented in
-- docs/phases/phase-05/data-migration-task.md.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "articles_title_trgm"
ON "articles" USING GIN ("title" gin_trgm_ops);
