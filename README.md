# api/ — NestJS Backend (The Truth Pill)

**Status:** Data layer + import complete (Phase 02) — 20-model Prisma schema,
5 applied migrations, generated client in `src/generated/prisma/`, and the
verified Convex → Neon import in `migration/`. **Application code (NestJS)
arrives in Phase 03.**
**Owner:** `truth-pill-backend` agent
**Deploy target:** Render Web Service + Render Background Worker
**Database:** Neon Postgres via Prisma (`@prisma/adapter-neon`)

---

## What Lives Here

This service replaces the entire `web/convex/` backend. It must reach **full
functional parity** with all **127** Convex functions (the baseline count; an
earlier draft of this file said 106) before the frontend
is cut over in Phase 10.

```
api/
├── src/
│   ├── core/              Layer 1 — global singletons (Prisma, Config, Logger)
│   ├── shared/            Layer 2 — stateless guards, decorators, filters, pipes
│   ├── modules/           Layer 3 — domain modules (one per Convex module)
│   │   ├── auth/
│   │   ├── users/
│   │   ├── articles/
│   │   ├── categories/
│   │   ├── pillars/
│   │   ├── quotes/
│   │   ├── engagement/
│   │   ├── analytics/
│   │   ├── stats/
│   │   ├── ai/
│   │   ├── emails/
│   │   ├── otp/
│   │   ├── search/
│   │   ├── settings/
│   │   └── admin/
│   ├── realtime/          SSE bus — replaces Convex reactive subscriptions
│   ├── worker/            @nestjs/schedule — replaces the 6 Convex crons
│   ├── infrastructure/    Layer 4 — Cloudinary, Nodemailer, Pexels, OpenAI
│   ├── app.module.ts
│   └── main.ts
├── prisma/
│   ├── schema.prisma      20 models, audited in Phase 01 (150/150 fields, 16 FKs)
│   └── migrations/        5 applied via `migrate deploy` — NEVER `migrate dev`
├── migration/             Phase 02 Convex → Neon importer + verifier (one-shot)
├── openapi.yaml           generated in Phase 03 — source of truth for the API contract
├── Dockerfile
├── .env.example
└── package.json
```

## `migration/` — the Convex → Neon import

One-shot tooling that loaded the frozen 2026-09-29 Convex production export into
the Neon dev branch: **5,878 rows read → 5,877 imported** (1 quarantined under
DEV-025). It is not runtime code and is not part of the deployed service.

Run everything from `api/`. All scripts need `--experimental-strip-types`.

| Script | Purpose |
|---|---|
| `verify-checksums.mts` | **Enforced pre-flight (P02-QA-002).** Reads the frozen export ZIP, hashes the archive and all 21 `<table>/documents.jsonl` entries, and compares against `docs/phases/phase-02/phase02-audit/export-checksums.txt`. Exit 0 only on a full match. Hashes/counts only — never prints file contents. |
| `precheck.mts` | Validates the export before touching the DB: file presence, JSONL parse, row counts, referential sanity. Read-only. |
| `import.mts` | The importer. Streams JSONL line-by-line, batches `createMany` at 1,000, remaps every `_id` through `id-map.json`, and resolves `comments.parentId` in a second pass. Quarantines only the two approved classes (DEV-023, DEV-025) and hard-fails on anything else. **Runs `verify-checksums.mts` first and refuses to import if the export fails verification.** |
| `checks.mts` | **The acceptance gate.** `checks.md` §0–§8: per-table counts, uniqueness, FK orphans, value shapes, counters, quarantine reconciliation, index inventory, §7 gate, idempotency, two-pass. Exits 0 only if the gate passes. |
| `fkcheck.mts` | Standalone FK orphan report. |
| `reset.mts` | Truncates the 20 application tables. **Destructive** — only ever against a dev branch. |
| `make-fixture.mts` | Generates the synthetic `comments.parentId` thread (see below). |
| `verify-two-pass.mts` | Reads the resolved comment tree back out of the DB and asserts the parent chain. |
| `clean-two-pass.mts` | Deletes the fixture rows. Leaves `comments` at 0, matching the export. |
| `verify-otp-lockout.mts` | Asserts the DEV-028 `otpCodes` lockout columns, DEV-027 width, the GIN drift index, 5,877 untouched rows, and 5/5 migrations. Read-only. |
| `id-map.json` | The 5,877-entry Convex `_id` → new-id map: **5,875 uuidv4 + 2 sentinels** (`site_settings`, `global_stats`). **Never hand-edit; never regenerate mid-run.** |
| `quarantine/` | The 6 quarantined source rows (5 DEV-023, 1 DEV-025), verbatim. |

Typical order:

```bash
node --experimental-strip-types migration/verify-checksums.mts   # P02-QA-002 pre-flight
node --experimental-strip-types migration/precheck.mts   # validate export
node --experimental-strip-types migration/import.mts     # load (runs verify-checksums itself)
node --experimental-strip-types migration/checks.mts     # gate — must exit 0
```

**Export integrity is enforced, not merely documented.** `import.mts` calls
`verify-checksums.mts` before a real or dry run and aborts with exit 1 on any
mismatch, so a drifted or tampered snapshot cannot land rows. `--fixture` skips
it (synthetic root, no real export). `PHASE02_SKIP_CHECKSUM=1` is an explicit
escape hatch and prints a loud SKIPPED line; it is never implied. The ZIP path
comes from `CONVEX_EXPORT_ZIP`, defaulting to the frozen snapshot; a second
argument overrides the expectation file, which exists for negative-control
testing.

**`id-map.json` is committed** (it contains opaque Convex `_id` strings and
derived ids, no user content). **`quarantine/` is committed** for the same
reason. The export itself is **not** in this repo — it is secret-bearing and
lives outside the working tree.

### Why the two-pass fixture exists

The production export contains **zero comments**, so `comments.parentId` is the
one self-referencing import path real data never exercises. Rather than assert
it works, a 6-row 3-level thread is pushed through the **real** importer,
verified by reading it back out of the DB, then removed:

```bash
node --experimental-strip-types migration/make-fixture.mts
node --experimental-strip-types migration/import.mts --fixture \
  migration/.fixture/two-pass-comments.jsonl
node --experimental-strip-types migration/verify-two-pass.mts
node --experimental-strip-types migration/clean-two-pass.mts
```

The fixture writes children **before** parents on purpose, so a single-pass
importer would leave the grandchild orphaned. It also includes one dangling
`parentId` that must be skipped rather than persisted. `--fixture` is the only
supported way to load it; there is no environment-variable switch. The fixture
writes its ID map to a separate `.fixture` path and never touches
`id-map.json`.

### `verify-otp-lockout.mts` — the P02-SEC-002 / DEV-028 proof

Asserts the four §CN-1 lockout columns on `otpCodes` exist with the intended
type, nullability and default; that the five frozen columns are intact; that
DEV-027's `code` width is still 128; that the permanent GIN drift index was **not**
dropped; that all 5,877 imported rows are untouched; and that `_prisma_migrations`
holds 5/5 finished, none rolled back. Read-only.

```bash
node --experimental-strip-types migration/verify-otp-lockout.mts   # exit 0
bash migration/regen-otp-proof.sh                                  # rebuilds the evidence file
```

The evidence file `docs/phases/phase-02/phase02-audit/otp-lockout-proof.txt`
carries a **negative control** — the same script's output from *before* the
migration, showing the four columns `ABSENT`. That block is a historical
capture and is not re-executable; see the note inside the file.

Evidence and the full acceptance record: `docs/phases/phase-02/phase02-audit/`.

## Known gap — DEV-008, deferred to Phase 05

`pg_trgm` and the `articles_title_trgm` fuzzy-title index are **not installed**.
`checks.mts` §6 reports this as a **non-blocking** warning — the exemption is an
explicit two-label allowlist, so any *other* §6 failure still fails the gate.
Tracked as **A3/A4** in `docs/migration-inventory.md`; lands with the search
module in Phase 05.

## Source of Truth

Do not infer the API surface from guesswork. The parity contract is:

- `docs/convex-ownership.md` — every Convex function → its Nest endpoint
- `docs/migration-inventory.md` — parity checklist, audited in Phase 13
- `docs/phases/phase-XX/backend-task.md` — the current phase's assignments

## Environment

See `api/.env.example` (created in Phase 03). Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL (`-pooler` host) — runtime queries |
| `DIRECT_URL` | Neon **direct** URL — `prisma migrate deploy` only |
| `AUTH_SECRET` | JWT signing, must match the web tier |
| `CORS_ORIGIN` | The web origin, e.g. `https://www.thetruthpill.org` |
| `INTERNAL_JOB_SECRET` | Authenticates Render Cron / worker self-calls |

## Hard Rules

1. **Never run `prisma migrate dev` against the Neon production branch.** It
   prompts to reset and will wipe migrated data. Use `migrate deploy`.
2. **Every mutation that touches a counter runs inside `$transaction`.** Convex
   mutations were serializable by default; Prisma gives no such guarantee.
3. **No client-supplied identity.** The current Convex code authorizes on a
   `userEmail` / `adminEmail` argument the caller controls. Every authenticated
   route must derive identity from a verified token. See
   `docs/phases/phase-04/`.
4. **Swagger decorators are mandatory** on every route and DTO property, or the
   frontend type generation in Phase 10 breaks.
