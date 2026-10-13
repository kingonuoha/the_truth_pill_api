// Reset the dev database to empty so the Phase 02 import can be proven as a
// single clean pass. DESTRUCTIVE — every row is deleted.
//
// Only ever run against the Neon DEV branch, never production, and only after
// confirming `api/.env` DATABASE_URL/DIRECT_URL point at the dev endpoint.
//
// Rows removed here are exactly the rows this importer wrote; they are fully
// reproducible from the frozen export because every id is a deterministic
// function of the source Convex _id.

import { disconnect, prisma } from './lib.mts'

const p = prisma()
const TABLES = [
  'globalStats','users','quotes','articles','categories','comments','reactions','bookmarks',
  'pageVisits','visitorTracking','dailyStats','aiSchedule','aiSettings','articleViews',
  'emailQueue','researchTopics','adsSettings','siteSettings','otpCodes','pillars',
]

if (process.argv.includes('--list')) {
  const sql = TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(' UNION ALL ')
  const rows: any[] = await p.$queryRawUnsafe(sql)
  let total = 0
  for (const r of rows) { total += r.n; if (r.n) console.log(`  ${r.t.padEnd(16)} ${r.n}`) }
  console.log(`\nrows that a reset would delete: ${total} across ${TABLES.length} tables`)
  await disconnect()
  process.exit(0)
}

if (!process.argv.includes('--yes')) {
  console.error('Refusing to run. Re-run with --list to preview, then --yes to delete.')
  await disconnect()
  process.exit(1)
}

// `current_database()` and `current_user` return the Postgres `name` type,
// which Prisma cannot deserialize. Cast to text.
const current: any[] = await p.$queryRawUnsafe(
  `SELECT current_database()::text AS db, current_user::text AS usr, inet_server_addr()::text AS host`,
)
console.log(`target: db=${current[0].db} user=${current[0].usr} host=${current[0].host}`)

const before: any[] = await p.$queryRawUnsafe(
  TABLES.map((t) => `SELECT count(*)::int AS n FROM "${t}"`).join(' UNION ALL ')
)
const beforeTotal = before.reduce((a, b) => a + b.n, 0)
console.log(`rows before reset: ${beforeTotal}`)

await p.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)

const after: any[] = await p.$queryRawUnsafe(
  TABLES.map((t) => `SELECT count(*)::int AS n FROM "${t}"`).join(' UNION ALL ')
)
const afterTotal = after.reduce((a, b) => a + b.n, 0)
console.log(`rows after reset : ${afterTotal}`)
console.log(afterTotal === 0 ? 'RESET OK — database is empty.' : '*** RESET FAILED — rows remain. ***')
await disconnect()
process.exit(afterTotal === 0 ? 0 : 1)
