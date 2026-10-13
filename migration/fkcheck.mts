// Pre-flight — the two ways a bulk import can silently LOSE a row, checked
// before a single row is written. Read-only: no database connection is opened.
//
//   1. FOREIGN KEYS   — a non-null relation value that resolves to no imported
//                       row will abort the INSERT and leave the table half
//                       loaded. Nullable columns are checked only when present.
//   2. UNIQUE COLLISIONS — `createMany({ skipDuplicates: true })` skips a row on
//                       ANY unique conflict, not just a primary-key conflict.
//                       A duplicate on a secondary unique constraint is a
//                       SILENT row loss, so it must be caught here.
//
// NOT an FK: `articleViews.visitorId` and `pageVisits.visitorId` are tracking
// codes (`web/convex/schema.ts:148` — "tracking code"), stored verbatim as
// `String @db.Uuid` with no relation in schema.prisma. They are checked as SOFT
// references and only reported, never failed: no constraint forbids an orphan.

import { APPROVED_REASONS, CFG, ID_GATE, loadIdMap, streamTable } from './lib.mts'

const FKS: Record<string, string[]> = {
  articles: ['authorId', 'categoryId'],
  comments: ['articleId', 'userId', 'parentId'],
  reactions: ['articleId', 'userId'],
  bookmarks: ['articleId', 'userId'],
  pageVisits: ['userId'],
  articleViews: ['articleId', 'userId'],
  researchTopics: ['categoryId'],
}

/** table -> secondary unique constraint columns (`@@unique`). */
const UNIQUES: Record<string, string[][]> = {
  users: [['email']],
  articles: [['slug']],
  categories: [['slug']],
  pillars: [['slug']],
  dailyStats: [['date']],
  reactions: [['articleId', 'userId']],
  bookmarks: [['articleId', 'userId']],
  articleViews: [['articleId', 'visitorId']],
  visitorTracking: [['trackingCode']],
}

const SOFT: Record<string, string> = {
  articleViews: 'visitorId',
  pageVisits: 'visitorId',
}

const idMap = loadIdMap().map
if (idMap.size === 0) {
  console.error('*** STOP: no persisted id-map. Run the dry run first.')
  process.exit(1)
}
console.log(`pre-flight: id-map has ${idMap.size} entries`)

// ── 1. foreign keys ─────────────────────────────────────────────────────────
// A row that ID_GATE rejects is one the importer deliberately quarantines, so
// it is counted as an expected quarantine rather than a violation. Classifying
// with the same gate keeps this pre-flight and the importer from drifting.
let fkChecked = 0
const fkViolations: string[] = []
const expectedQuarantine: Record<string, number> = {}
for (const [table, cols] of Object.entries(FKS)) {
  const gate = ID_GATE[table]
  let rows = 0
  let gated = 0
  for await (const { doc, error, lineNo } of streamTable(CFG.exportRoot, table)) {
    if (error || !doc) continue
    rows++
    if (gate && !gate(doc, idMap)) {
      gated++
      continue
    }
    for (const col of cols) {
      const v = doc[col]
      if (v === null || v === undefined || v === '') continue
      fkChecked++
      if (!idMap.has(v)) fkViolations.push(`${table}.${col} @ line ${lineNo}`)
    }
  }
  if (gated) expectedQuarantine[table] = gated
  console.log(`  FK  ${table.padEnd(14)} rows=${String(rows).padStart(5)}  columns: ${cols.join(', ')}${gated ? `  (gated->quarantine: ${gated})` : ''}`)
}
console.log(`\nnon-null FK values checked  : ${fkChecked}`)
console.log(`rows routed to quarantine   : ${Object.entries(expectedQuarantine).map(([t, n]) => `${t}=${n}`).join(', ') || 'none'}`)
console.log(`unresolvable FK values      : ${fkViolations.length}`)
for (const v of fkViolations) console.error(`  *** ${v}`)

// ── 2. unique-constraint collisions ─────────────────────────────────────────
let uniqueChecked = 0
const collisions: string[] = []
for (const [table, groups] of Object.entries(UNIQUES)) {
  for (const cols of groups) {
    const seen = new Set<string>()
    let dupes = 0
    for await (const { doc, error, lineNo } of streamTable(CFG.exportRoot, table)) {
      if (error || !doc) continue
      uniqueChecked++
      const key = JSON.stringify(cols.map((c) => doc[c] ?? null))
      if (seen.has(key)) {
        dupes++
        if (collisions.length < 20) collisions.push(`${table} (${cols.join(',')}) @ line ${lineNo}`)
      }
      seen.add(key)
    }
    console.log(`  UQ  ${table.padEnd(14)} ${cols.join(',').padEnd(24)} duplicates=${dupes}`)
  }
}
console.log(`\nrows checked for unique collisions: ${uniqueChecked}`)
console.log(`duplicate-key rows (silent loss) : ${collisions.length === 0 ? 0 : '>' + collisions.length}`)
for (const c of collisions) console.error(`  *** ${c}`)

// ── 3. soft references (tracking codes) — reported, never fatal ─────────────
const trackingCodes = new Set<string>()
for await (const { doc } of streamTable(CFG.exportRoot, 'visitorTracking')) {
  if (doc) trackingCodes.add(doc.trackingCode)
}
console.log(`\nvisitorTracking.trackingCode values: ${trackingCodes.size}`)
let softTotal = 0
let softOrphan = 0
for (const [table, col] of Object.entries(SOFT)) {
  let n = 0
  let orphan = 0
  for await (const { doc } of streamTable(CFG.exportRoot, table)) {
    if (!doc || !doc[col]) continue
    n++
    if (!trackingCodes.has(doc[col])) orphan++
  }
  softTotal += n
  softOrphan += orphan
  console.log(`  SOFT ${table.padEnd(14)} ${col}: ${n} values, ${orphan} without a visitorTracking row`)
}
console.log(`\nsoft-reference values: ${softTotal}, without a trackingCode match: ${softOrphan} (no FK — informational)`)

// ID_GATE gates exactly the 1 DEV-025 row. The 5 DEV-023 articles are NOT
// gated — they are imported with `pillar = NULL` and the rejected value is
// quarantined alongside them — so they never reach this count.
const gated = Object.values(expectedQuarantine).reduce((a, b) => a + b, 0)
if (gated !== 1) {
  fkViolations.push(`ID_GATE quarantines ${gated} row(s); the approved DEV-025 set is exactly 1`)
}
console.log(`\napproved quarantine classes : ${APPROVED_REASONS.join(', ')}`)
console.log(`rows gated out of the import: ${gated} (DEV-025 only; DEV-023 imports with pillar=NULL)`)

const failed = fkViolations.length > 0 || collisions.length > 0
console.log(
  failed
    ? '\n*** VERDICT: PRE-FLIGHT FAILED — do not import. ***'
    : '\nVERDICT: no unresolvable foreign key and no unique collision — safe to import.',
)
process.exit(failed ? 1 : 0)
