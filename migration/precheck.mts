// §0/§1 empty-database precondition query set (task file §0 bullet 2).
// SELECT only. Aggregates only — no values.
import { loadEnv, disconnect, prisma } from './lib.mts'

const TABLES = [
  'globalStats','users','quotes','articles','categories','comments','reactions','bookmarks',
  'pageVisits','visitorTracking','dailyStats','aiSchedule','aiSettings','articleViews',
  'emailQueue','researchTopics','adsSettings','siteSettings','otpCodes','pillars',
]

const p = prisma()
const sql = TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(' UNION ALL ')
const rows: any[] = await p.$queryRawUnsafe(sql)
let total = 0
let nonEmpty = 0
for (const r of rows) {
  total += r.n
  if (r.n !== 0) nonEmpty++
  console.log(`  ${String(r.t).padEnd(16)} ${r.n}`)
}
console.log(`\nTABLES: ${rows.length}   TOTAL ROWS: ${total}   NON-EMPTY TABLES: ${nonEmpty}`)
console.log(total === 0 ? 'VERDICT: dev database is EMPTY — precondition for the Phase 02 import holds.' : '*** VERDICT: NOT EMPTY — STOP, stray rows. ***')
await disconnect()
process.exit(total === 0 ? 0 : 1)
