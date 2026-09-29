-- Full-text search for articles — the Postgres equivalent of the Convex
-- `.searchIndex("search_title", ...)` on web/convex/schema.ts:94-97.
--
-- Convex handed over a ready-made, self-updating index. Postgres does not, so
-- this migration builds the same behaviour out of three parts:
--
--   1. articles_search_vector_update()  — refills `searchVector` on write
--   2. articles_search_vector_trigger   — calls it on every insert/update
--   3. articles_searchVector_idx        — the GIN index that makes it fast
--
-- WHY A TRIGGER AND NOT APPLICATION CODE:
-- `searchVector` is declared `Unsupported("tsvector")` in schema.prisma, which
-- means Prisma does not read or write it. Nothing in the app layer can keep it
-- correct. Any write that bypasses the repository — a script, a manual fix, a
-- future bulk edit — would silently leave search stale and the site would
-- return wrong results. The trigger makes staleness structurally impossible.
--
-- WEIGHTS: title is the strongest signal (A), excerpt supports it (B). Both
-- feed one tsvector so they are matched in a single index lookup.
--
-- Convex searched `title` only. This searches title + excerpt, which returns
-- better results for the same cost. Deliberate, logged in docs/deviations.md.

-- 1. The function that builds the searchable text.
CREATE OR REPLACE FUNCTION articles_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."searchVector" :=
       setweight(to_tsvector('english', coalesce(NEW."title",   '')), 'A')
    || setweight(to_tsvector('english', coalesce(NEW."excerpt", '')), 'B');
  RETURN NEW;
END;
$$;

-- 2. The trigger. BEFORE so the stored row is already correct when written.
CREATE TRIGGER articles_search_vector_trigger
BEFORE INSERT OR UPDATE OF "title", "excerpt"
ON "articles"
FOR EACH ROW
EXECUTE FUNCTION articles_search_vector_update();

-- 3. The index. This is the part that makes search fast — without it Postgres
--    rescans every article on every query.
CREATE INDEX "articles_searchVector_idx"
ON "articles" USING GIN ("searchVector");

-- Backfill any rows written before this migration existed.
UPDATE "articles"
SET "searchVector" =
       setweight(to_tsvector('english', coalesce("title",   '')), 'A')
    || setweight(to_tsvector('english', coalesce("excerpt", '')), 'B')
WHERE "searchVector" IS NULL;

-- Convex's search index also filtered on these. `status` and
-- `status_categoryId` are already indexed in the schema; `isArchived` is not.
CREATE INDEX "articles_isArchived_idx" ON "articles" ("isArchived");
