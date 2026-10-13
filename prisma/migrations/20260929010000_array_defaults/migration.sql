-- Phase 01 — DEV-026. Give every scalar-list column an empty-array DEFAULT.
--
-- Prisma's canonical DDL for `String[] @default([])` is a NULLABLE column with
-- `DEFAULT ARRAY[]::TEXT[]` (it cannot express NOT NULL on a list). Convex
-- OMITS an absent optional array, so a raw create that skips the field used to
-- store NULL, and Prisma's read type (`T[]`) then hit a runtime error on it.
--
-- This migration does exactly what `prisma migrate diff` wants for the model
-- + `@default([])` additions — except the searchVector DROP, which is the
-- accepted permanent drift (GIN index Prisma cannot express). The backfill
-- UPDATEs below repair the rows that predate the default so no NULL array
-- survives.

-- AlterTable
ALTER TABLE "aiSchedule" ALTER COLUMN "daysOfWeek" SET DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "aiSchedule" ALTER COLUMN "topicsToResearch" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "articles" ALTER COLUMN "topics" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "articles" ALTER COLUMN "tags" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "categories" ALTER COLUMN "pexelsImages" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "pillars" ALTER COLUMN "pexelsImages" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ALTER COLUMN "completedTours" SET DEFAULT ARRAY[]::TEXT[];

-- Data backfill: pre-default NULL arrays would still break a Prisma read.
UPDATE "aiSchedule" SET "daysOfWeek" = ARRAY[]::INTEGER[] WHERE "daysOfWeek" IS NULL;
UPDATE "aiSchedule" SET "topicsToResearch" = ARRAY[]::TEXT[] WHERE "topicsToResearch" IS NULL;
UPDATE "articles" SET "topics" = ARRAY[]::TEXT[] WHERE "topics" IS NULL;
UPDATE "articles" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
UPDATE "categories" SET "pexelsImages" = ARRAY[]::TEXT[] WHERE "pexelsImages" IS NULL;
UPDATE "pillars" SET "pexelsImages" = ARRAY[]::TEXT[] WHERE "pexelsImages" IS NULL;
UPDATE "users" SET "completedTours" = ARRAY[]::TEXT[] WHERE "completedTours" IS NULL;