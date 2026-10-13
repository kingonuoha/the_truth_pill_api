// ═════════════════════════════════════════════════════════════════════════════
// Phase 02 — the import runner.
//
//   node --experimental-strip-types migration/import.mts --dry-run
//   node --experimental-strip-types migration/import.mts
//   node --experimental-strip-types migration/import.mts --fixture <file>
//
// MODES
//   (default)  full import to the dev branch
//   --dry-run  count-only + quarantine simulation, ZERO writes to Postgres
//   --fixture  run an arbitrary JSONL file through THE SAME pipeline, into a
//              caller-named table. Used by two-pass-fixture.mts, which is how
//              ADR-008's self-referencing `comments.parentId` path gets proven
//              against a 3-level tree (production has 0 comments).
//
// Never prints a secret-bearing value. See lib.mts for the security contract.
// ═════════════════════════════════════════════════════════════════════════════

import {
  APPROVED_REASONS,
  CFG,
  ID_GATE,
  SINGLETON_IDS,
  TRANSFORMS,
  assertModelMap,
  bump,
  detUuid,
  disconnect,
  initQuarantine,
  listQuarantine,
  loadIdMap,
  model,
  prisma,
  quarantine,
  saveIdMap,
  streamTable,
  newReport,
} from './lib.mts'
import type { IdMap, TableReport } from './lib.mts'
import { DEFAULT_ZIP, verifyChecksums } from './verify-checksums.mts'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const FIXTURE_IDX = argv.indexOf('--fixture')
const FIXTURE_FILE = FIXTURE_IDX >= 0 ? argv[FIXTURE_IDX + 1] : null
const FIXTURE_TABLE = argv.includes('--fixture-table') ? argv[argv.indexOf('--fixture-table') + 1] : 'comments'
const SKIP_COUNTERS = argv.includes('--skip-counters')

// Fixture mode re-points the export root at a one-table directory so the REAL
// pipeline (streaming, transform, batch insert, pass-2 UPDATE) runs unmodified
// against synthetic rows. It writes to the real database on purpose: a pass-2
// self-reference UPDATE cannot be proven without executing it. The caller
// deletes the fixture rows afterwards and asserts the table is empty again.
let exportRoot = CFG.exportRoot
let fixtureRoot: string | null = null
if (FIXTURE_FILE) {
  const { mkdtempSync, mkdirSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  fixtureRoot = mkdtempSync(j(tmpdir(), 'phase02-fixture-'))
  mkdirSync(j(fixtureRoot, FIXTURE_TABLE), { recursive: true })
  copyFileSync(FIXTURE_FILE, j(fixtureRoot, FIXTURE_TABLE, 'documents.jsonl'))
  exportRoot = fixtureRoot
}

const out: string[] = []
const say = (s = '') => out.push(s)

const t0 = Date.now()
const mode = FIXTURE_FILE ? `FIXTURE (${FIXTURE_TABLE})` : DRY ? 'DRY RUN' : 'REAL RUN'
say(`Phase 02 import — ${mode}`)
say(`export root: ${exportRoot}`)
say(`batch size : ${CFG.batchSize}`)
say(`started    : ${new Date().toISOString()}`)
say('')

let unexpected = 0
const unexpectedRows: { table: string; reason: string; lineNo: number }[] = []

// ── Pre-flight — enforce export integrity BEFORE reading anything ────────────
//
// P02-QA-002. The import reads the frozen Convex export; if that snapshot has
// drifted or been tampered with, every row loaded from it is suspect. So the
// archive is verified against `phase02-audit/export-checksums.txt` first, and a
// mismatch STOPS the run rather than landing bad rows.
//
// Scope: REAL and DRY runs (both read the frozen root). `--fixture` is skipped —
// it points the pipeline at a synthetic temp root and consumes no real export.
// `PHASE02_SKIP_CHECKSUM=1` is an explicit, loud escape hatch (e.g. after the
// Phase 13 export deletion); it is never implied.
if (!FIXTURE_FILE) {
  const zipPath = process.env.CONVEX_EXPORT_ZIP ?? DEFAULT_ZIP
  if (process.env.PHASE02_SKIP_CHECKSUM === '1') {
    say('export integrity: *** SKIPPED — PHASE02_SKIP_CHECKSUM=1 was set explicitly ***')
  } else {
    try {
      const r = verifyChecksums(zipPath)
      if (!r.ok) {
        say(`*** STOP: export integrity check FAILED — ${r.failCount} of ${r.files.length} files differ${r.zipMatch === false ? ', and the ZIP hash differs' : ''}.`)
        say('*** Refusing to import from an unverified export. Investigate before overriding.')
        console.log(out.join('\n'))
        await disconnect()
        process.exit(1)
      }
      say(`export integrity: OK — ${r.okCount}/${r.files.length} files, ${r.totalRows} rows, zip ${r.zipSha256.slice(0, 16)}`)
    } catch (e) {
      say(`*** STOP: export integrity check could not run: ${(e as Error).message}`)
      say('*** Refusing to import from an unverified export.')
      console.log(out.join('\n'))
      await disconnect()
      process.exit(1)
    }
  }
}

// ── Phase 1 — resolve the id-map BEFORE any insert ──────────────────────────
//
// Every relation resolves through this map, so it must be complete before the
// first insert. Two passes over the export: pass A records every source `_id`
// (and refuses to overwrite an existing entry — Convex `_id`s are globally
// unique, so a collision is a corrupt export and a STOP).

// The persisted id-map is the authority. If it exists it is loaded and reused
// verbatim — regenerating it would silently change every id in the database on
// a re-run, which is the one thing this migration must never do.
const loaded = loadIdMap()
const idMap: IdMap = loaded.map
if (loaded.reused) say(`id-map: LOADED ${idMap.size} existing entries (reused, never regenerated)`)
else say('id-map: no persisted map found — deriving')

const sourceIds = new Set<string>()
for (const { name: table, singleton } of TRANSFORMS) {
  const gate = ID_GATE[table]
  for await (const { doc, error, lineNo } of streamTable(exportRoot, table)) {
    if (error || !doc) continue
    const oldId = doc._id as string
    if (sourceIds.has(oldId)) {
      say(`*** STOP: duplicate Convex _id across tables: ${oldId}`)
      process.exit(1)
    }
    sourceIds.add(oldId)
    // A row that is going to be quarantined gets NO new id, so the id-map holds
    // only the ids that can actually exist in the target database.
    if (gate && !gate(doc, idMap)) continue
    if (singleton) {
      // Singletons take a FIXED literal id so re-running is an upsert, and so
      // the id-map still records the mapping (B2 requires 5,877 entries).
      if (idMap.has(oldId) && idMap.get(oldId) !== SINGLETON_IDS[table]) {
        say(`*** STOP: singleton ${table} already mapped to a different id`)
        process.exit(1)
      }
      idMap.set(oldId, SINGLETON_IDS[table])
    } else if (!idMap.has(oldId)) {
      idMap.set(oldId, detUuid(oldId))
    }
  }
}
say(`id-map: ${idMap.size} entries after resolution (${sourceIds.size} source _ids)`)

// The pillar slug set is needed to apply DEV-023. It is read from the export,
// never from the database, so a dry run and a real run decide identically.
const pillarSlugs = new Set<string>()
for await (const { doc } of streamTable(exportRoot, 'pillars')) if (doc) pillarSlugs.add(doc.slug)
say(`pillars: ${pillarSlugs.size} slugs loaded (DEV-023 resolution set)`)
say('')

// ── Phase 2 — stream + transform + batch insert ─────────────────────────────

// Every table must resolve to a real Prisma delegate before a single row is
// written. A 20-table import that silently lands 6 tables is a data-loss bug,
// not a partial success.
if (!DRY) {
  assertModelMap(prisma())
  say('model map: all 20 tables resolve to a Prisma delegate')
}

const reports: TableReport[] = []
let totalInserted = 0
let totalQuarantined = 0
const qRoot = DRY ? CFG.dryRunQuarantineRoot : CFG.quarantineRoot
if (!FIXTURE_FILE) initQuarantine(qRoot)

/** Pending pass-2 (parentId) resolutions for the self-referencing table. */
const deferred: { child: string; parentSourceId: string }[] = []

for (const { name: table, fn: transform } of TRANSFORMS) {
  if (FIXTURE_FILE && table !== FIXTURE_TABLE) continue

  const report = newReport(table)
  const db = DRY ? null : prisma()
  const delegate = db ? model(db, table) : null

  // Idempotency pre-check: which of this table's deterministic ids already
  // exist? One query, not one per row. `skipDuplicates` on createMany is the
  // hard guarantee; this is what makes the re-run report legible.
  // In dry-run there is no database, so `delegate` is null and nothing is read.
  let existing = new Set<string>()
  if (delegate) {
    const rows: { id: string }[] = await delegate.findMany({ select: { id: true } })
    existing = new Set(rows.map((r) => r.id))
  }

  let batch: Record<string, unknown>[] = []
  const flush = async () => {
    if (batch.length === 0) return
    if (delegate) {
      const r = await delegate.createMany({ data: batch, skipDuplicates: true })
      report.inserted += r.count
      totalInserted += r.count
    }
    report.batches++
    report.batchSizes.push(batch.length)
    batch = []
  }

  for await (const { doc, error, lineNo } of streamTable(exportRoot, table)) {
    report.read++
    if (error || !doc) {
      // A per-line failure is quarantined with a reason and the batch continues.
      unexpected++
      unexpectedRows.push({ table, reason: 'unparseable-line', lineNo })
      bump(report, 'UNEXPECTED-unparseable-line')
      report.quarantined++
      quarantine(qRoot, 'UNEXPECTED/' + table, 'unparseable-line', { table, lineNo, reason: error })
      continue
    }
    let outcome
    try {
      outcome = transform(doc, { idMap, pillarSlugs, table })
    } catch (e) {
      unexpected++
      unexpectedRows.push({ table, reason: 'transform-threw', lineNo })
      bump(report, 'UNEXPECTED-transform-threw')
      report.quarantined++
      quarantine(qRoot, 'UNEXPECTED/' + table, 'transform-threw', { table, lineNo, reason: (e as Error).message.slice(0, 200) })
      continue
    }
    if ((outcome as any).__apiKeyAssertion) {
      say(`aiSettings DEV-015 assertion: ${(outcome as any).__apiKeyAssertion}`)
    }
    if ((outcome as any).__parentSource) {
      deferred.push({ child: idMap.get(doc._id)!, parentSourceId: (outcome as any).__parentSource })
    }
    if (outcome.quarantine) {
      // DEV-023 / DEV-025 are the two APPROVED classes. Anything else is a
      // stop-and-report, never a silent insert and never a silent drop.
      const approved = APPROVED_REASONS.includes(outcome.quarantine.reason)
      if (!approved) {
        unexpected++
        unexpectedRows.push({ table, reason: outcome.quarantine.reason, lineNo })
      }
      bump(report, outcome.quarantine.reason)
      report.valuesQuarantined++
      quarantine(qRoot, table, outcome.quarantine.reason, outcome.quarantine.record)

      // A quarantine record does NOT imply the row is held back. DEV-023
      // quarantines the rejected `pillar` VALUE while the article itself is
      // still imported with pillar = NULL. Only a null `data` means the row is
      // dropped from the import (DEV-025).
      if (!outcome.data) {
        // Invariant: a dropped row must NOT hold an id in the map, or a later
        // table's FK can point at a row that will never exist. This is what
        // breaks the import, and it is cheap to assert here.
        if (idMap.has(doc._id as string)) {
          say(`*** STOP: ${table} line ${lineNo} was quarantined as '${outcome.quarantine.reason}' but its _id is in the id-map — a dependent row would violate its foreign key.`)
          process.exit(1)
        }
        report.quarantined++
        continue
      }
    }
    const data = outcome.data as Record<string, unknown>
    if (!data) {
      unexpected++
      bump(report, 'UNEXPECTED-null-transform')
      report.quarantined++
      continue
    }
    if (existing.has(data.id as string)) {
      report.alreadyPresent++
      report.eligible++
      continue
    }
    report.eligible++
    batch.push(data)
    if (batch.length >= CFG.batchSize) await flush()
  }
  await flush()

  // ── pass 2 (ADR-008) — resolve the self-reference in ONE statement ────────
  if (deferred.length > 0) {
    const pairs = deferred.filter((d) => d.parentSourceId)
    if (pairs.length > 0) {
      const values = pairs
        .map((p) => {
          const parent = idMap.get(p.parentSourceId)
          if (!parent) return null
          return `('${p.child}'::uuid,'${parent}'::uuid)`
        })
        .filter(Boolean)
        .join(',')
      if (values) {
        if (delegate) {
          const r = await prisma().$executeRawUnsafe(
            `UPDATE "comments" c SET "parentId" = v."parentId"::uuid
               FROM (VALUES ${values}) AS v(id, "parentId") WHERE c.id = v.id::uuid`
          )
          report.batches++
          report.batchSizes.push(pairs.length)
          say(`comments pass 2: resolved ${pairs.length} parentId reference(s) in 1 statement (${r} rows updated)`)
        } else {
          say(`comments pass 2: ${pairs.length} parentId reference(s) prepared (dry run — no database write)`)
        }
      }
    }
    deferred.length = 0
  }

  reports.push(report)
  say(
    `  ${table.padEnd(16)} read=${String(report.read).padStart(5)}  ` +
      `quarantined=${String(report.quarantined).padStart(2)}  valueQ=${String(report.valuesQuarantined).padStart(2)}  eligible=${String(report.eligible).padStart(5)}  ` +
      `alreadyPresent=${String(report.alreadyPresent).padStart(5)}  inserted=${String(report.inserted).padStart(5)}  ` +
      `batches=${report.batches}${report.batchSizes.length ? ' [' + report.batchSizes.join(',') + ']' : ''}`
  )
  totalQuarantined += report.quarantined
}
say('')

// ── Phase 3 — the DEV-021 / DEV-022 cache recomputation, ONE $transaction ────
//
// AGENTS.md migration rule 5: serializability is not free in Prisma. A counter
// written outside the transaction is a lost update under any concurrency. These
// are the ONLY writes after the insert phase, and `articles.viewCount` /
// `uniqueViewCount` are deliberately NOT touched (DEV-016 — they are not
// re-derivable, see phase-01/checks.md §4).

let countersApplied = false
if (!DRY && !FIXTURE_FILE && !SKIP_COUNTERS && totalInserted > 0) {
  const p = prisma()
  const t = await p.$transaction([
    // DEV-021 — reactionsCount = count(reactions) per article, for ALL articles
    // (including the ones that must go to 0, which a join-driven UPDATE would
    // silently skip).
    p.$executeRawUnsafe(
      `UPDATE "articles" a
          SET "reactionsCount" = (SELECT count(*)::int FROM "reactions" r WHERE r."articleId" = a.id)`
    ),
    // DEV-022 — categories.articleCount, transcribed from web/convex/stats.ts:45-51
    p.$executeRawUnsafe(
      `UPDATE "categories" c
          SET "articleCount" = (SELECT count(*)::int FROM "articles" a
                                 WHERE a."categoryId" = c.id AND coalesce(a."isArchived", false) = false)`
    ),
    // DEV-022 — all ten globalStats counters, transcribed from
    // web/convex/stats.ts:9-43 (phase-01/checks.md §4.1 is the authority).
    //   totalViews       = sum(dailyStats.visits)      (option A, signed off)
    //   totalUniqueViews = count(visitorTracking)      (stats.ts:25)
    p.$executeRawUnsafe(
      `UPDATE "globalStats" SET
         "articleCount"          = (SELECT count(*)::int FROM "articles" WHERE coalesce("isArchived", false) = false),
         "publishedArticleCount" = (SELECT count(*)::int FROM "articles" WHERE coalesce("isArchived", false) = false AND "status" = 'published'),
         "draftArticleCount"     = (SELECT count(*)::int FROM "articles" WHERE coalesce("isArchived", false) = false AND "status" = 'draft'),
         "scheduledArticleCount" = (SELECT count(*)::int FROM "articles" WHERE coalesce("isArchived", false) = false AND "status" = 'scheduled'),
         "aiDraftCount"          = (SELECT count(*)::int FROM "articles" WHERE coalesce("isArchived", false) = false AND "source" = 'ai' AND "status" = 'draft'),
         "usersCount"            = (SELECT count(*)::int FROM "users"),
         "commentsCount"         = (SELECT count(*)::int FROM "comments"),
         "pendingCommentsCount"  = (SELECT count(*)::int FROM "comments" WHERE "status" = 'pending'),
         "totalViews"            = (SELECT coalesce(sum("visits"), 0)::int FROM "dailyStats"),
         "totalUniqueViews"      = (SELECT count(*)::int FROM "visitorTracking"),
         "updatedAt"             = now()`
    ),
  ])
  countersApplied = true
  say(`counters: recomputed in ONE $transaction (${Array.isArray(t) ? t.length : 1} statements, atomic)`)
} else if (!DRY && !FIXTURE_FILE && !SKIP_COUNTERS) {
  say('counters: SKIPPED — 0 rows inserted, so every counter already holds the recomputed value (idempotent)')
}
say('')

// ── Phase 4 — id-map persistence (B2) ───────────────────────────────────────

let mapEntries = 0
if (!FIXTURE_FILE) {
  mapEntries = FIXTURE_FILE ? 0 : saveIdMap(idMap)
  say(`id-map: persisted ${mapEntries} entries to migration/id-map.json (expected ${CFG.expectedIdMapEntries})`)
} else {
  saveIdMap(idMap, `${CFG.idMapPath}.fixture`)
  say('id-map: fixture map written to migration/id-map.json.fixture (the real map is untouched)')
}
say('')

// ── Phase 5 — report ────────────────────────────────────────────────────────

say('quarantine files:')
const qfiles = listQuarantine(qRoot)
if (qfiles.length === 0) say('  (none)')
for (const f of qfiles) say(`  ${f.file.padEnd(46)} ${f.rows} row(s)`)
say('')

say('unexpected (UNEXPECTED/ or reason outside the two approved classes):')
say(`  ${unexpected} row(s)`)
for (const u of unexpectedRows.slice(0, 20)) say(`    ${u.table} line ${u.lineNo} — ${u.reason}`)
if (unexpectedRows.length > 20) say(`    ... and ${unexpectedRows.length - 20} more`)
say('')

const secs = ((Date.now() - t0) / 1000).toFixed(1)
say(`rows read        : ${reports.reduce((a, r) => a + r.read, 0)}`)
say(`rows inserted    : ${totalInserted}`)
say(`rows quarantined : ${totalQuarantined}`)
say(`counters         : ${countersApplied ? 'recomputed' : DRY ? 'skipped (dry run)' : 'skipped (nothing inserted)'}`)
say(`wall time        : ${secs}s`)
say('')
say(
  unexpected === 0
    ? 'RESULT: clean — no row entered quarantine for a reason outside DEV-023 / DEV-025.'
    : '*** RESULT: UNEXPECTED QUARANTINE. STOP AND REPORT. ***'
)

console.log(out.join('\n'))
await disconnect()
process.exit(unexpected === 0 ? 0 : 2)
