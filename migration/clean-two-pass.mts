// Deletes the two-pass fixture rows and asserts the table returns to its
// production state (the Convex export holds zero comments).
//
// The fixture IDs are not in the persisted id-map, so they are identified by
// their fixed fixture content/createdAt rather than by id. This is destructive
// against the comments table and is only ever correct while comments is empty
// in the source data — which the importer and checks both assert.

import { model, prisma } from './lib.mts'

const p = prisma()
const comments = model(p, 'comments')
// Convex stores createdAt as v.float64() epoch ms; the Prisma model types it as
// DateTime, so the same instant is matched as a Date.
const FIXTURE_T = new Date(1750000000000)

const before = await comments.count()
console.log(`comments before cleanup: ${before}`)

const del = await comments.deleteMany({ where: { createdAt: { equals: FIXTURE_T } } })
console.log(`fixture rows deleted: ${del.count}  (expect 6)`)

const after = await comments.count()
console.log(`comments after cleanup : ${after}  (expect 0 — the production export has no comments)`)

await p.$disconnect()
if (del.count !== 6 || after !== 0) {
  console.error('❌ cleanup did not restore the table')
  process.exit(1)
}
console.log('✅ fixture removed, comments back to 0')
