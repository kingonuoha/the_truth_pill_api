import { PrismaClient } from '../src/generated/prisma/client.ts'
import { PrismaNeon } from '@prisma/adapter-neon'
import { readFileSync } from 'node:fs'

const env: Record<string, string> = {}
for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const db = new PrismaClient({ adapter: new PrismaNeon({ connectionString: env.DATABASE_URL }) })
const tables = ['globalStats', 'users', 'articles', 'categories', 'comments', 'reactions', 'bookmarks', 'pageVisits', 'visitorTracking', 'dailyStats', 'aiSchedule', 'aiSettings', 'articleViews', 'emailQueue', 'researchTopics', 'adsSettings', 'siteSettings', 'otpCodes', 'pillars', 'quotes']
let total = 0
for (const t of tables) {
  const r = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`)
  total += r[0].n
}
const c = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "comments"`)
console.log(`FINAL DB TOTAL ROWS = ${total} (expect 5877)`)
console.log(`comments = ${c[0].n} (expect 0, fixture cleaned)`)
await db.$disconnect()
process.exit(total === 5877 && c[0].n === 0 ? 0 : 1)
