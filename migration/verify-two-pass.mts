// Post-insertion verification for the two-pass fixture (§8.3).
//
// The production export has zero comments, so `comments.parentId` is the only
// import path real data never exercises. This reads the fixture rows back out
// of the database and proves the self-referencing tree was actually resolved.
//
// Expected end state, given the fixture in make-fixture.mts:
//
//   f1 "root comment"          parentId NULL
//   f2 "child of f1"           parentId = f1
//   f3 "grandchild of f2"      parentId = f2
//   f4 "second root comment"   parentId NULL
//   f5 "child of f4"           parentId = f4
//   f6 "parent will not resolve"  parentId NULL  <- deliberate dangling ref,
//                               skipped by pass 2, NOT written as a bad FK
//
// So: 4 resolvable references updated, 2 roots + 1 skipped row have a NULL
// parentId, and ZERO orphans — pass 2 skips an unresolvable reference rather
// than aborting the batch or writing a dangling id.
//
// Every alias is quoted. Postgres folds unquoted aliases to lowercase, so
// `AS parentContent` comes back as `parentcontent`.

import { prisma } from './lib.mts'

const p = prisma()

const rows = await p.$queryRawUnsafe<any[]>(
  `SELECT c.content,
          c.status,
          c."parentId"::text                     AS "parentId",
          pa.content                            AS "parentContent",
          gp.content                            AS "grandparentContent",
          a.slug                                AS "articleSlug"
     FROM comments c
     LEFT JOIN comments pa ON pa.id = c."parentId"
     LEFT JOIN comments gp ON gp.id = pa."parentId"
     LEFT JOIN articles  a  ON a.id  = c."articleId"
    ORDER BY c."createdAt", c.id`,
)

console.log(`comments rows: ${rows.length}  (expect 6)`)
for (const r of rows) {
  console.log(
    `   content=${JSON.stringify(r.content).padEnd(20)} status=${String(r.status).padEnd(9)}` +
      ` parent=${JSON.stringify(r.parentContent ?? null).padEnd(20)}` +
      ` grandparent=${JSON.stringify(r.grandparentContent ?? null).padEnd(20)}` +
      ` article=${r.articleSlug}`,
  )
}

const byContent = (c: string) => rows.find((r) => r.content === c) ?? null
const expectNullParent = (c: string, why: string) => {
  const r = byContent(c)
  const ok = !!r && r.parentId === null
  console.log(`   ${ok ? '✅' : '❌'} ${c.padEnd(20)} parentId NULL — ${why}`)
  return ok
}
const expectParent = (c: string, parent: string) => {
  const r = byContent(c)
  const ok = !!r && !!r.parentContent && r.parentContent === parent
  console.log(`   ${ok ? '✅' : '❌'} ${c.padEnd(20)} parentId → ${JSON.stringify(parent)} (got ${JSON.stringify(r?.parentContent ?? null)})`)
  return ok
}
const expectGrandparent = (c: string, gp: string) => {
  const r = byContent(c)
  const ok = !!r && r.grandparentContent === gp
  console.log(`   ${ok ? '✅' : '❌'} ${c.padEnd(20)} grandparent → ${JSON.stringify(gp)} (got ${JSON.stringify(r?.grandparentContent ?? null)})`)
  return ok
}

console.log('\nresolved tree:')
const checks = [
  expectNullParent('root comment', 'true root'),
  expectParent('child of f1', 'root comment'),
  expectParent('grandchild of f2', 'child of f1'),
  expectNullParent('second root comment', 'true root'),
  expectParent('child of f4', 'second root comment'),
  expectNullParent('parent will not resolve', 'dangling ref skipped by pass 2, not written'),
  expectGrandparent('grandchild of f2', 'root comment'),
]

// Zero orphans is the point: an unresolvable reference must be left NULL, never
// written as a dangling id. So f6 is NOT an orphan.
const dangling = await p.$queryRawUnsafe<{ n: number }[]>(
  `SELECT count(*)::int AS n FROM comments c
    WHERE c."parentId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM comments x WHERE x.id = c."parentId")`,
)
console.log(`\norphaned parentId refs: ${dangling[0].n}  (expect 0 — f6 was left NULL, not written dangling)`)
checks.push(dangling[0].n === 0)

const roots = await p.$queryRawUnsafe<{ n: number }[]>(
  `SELECT count(*)::int AS n FROM comments WHERE "parentId" IS NULL`,
)
console.log(`root rows (parentId NULL): ${roots[0].n}  (expect 3 — f1, f4, and f6)`)
checks.push(roots[0].n === 3)

const fk = await p.$queryRawUnsafe<{ n: number }[]>(
  `SELECT count(*)::int AS n FROM comments c
    WHERE c."articleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = c."articleId")
       OR c."userId"    IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users    u WHERE u.id = c."userId")`,
)
console.log(`comments with a broken articleId/userId FK: ${fk[0].n}  (expect 0)`)
checks.push(fk[0].n === 0)

const statusOk = rows.filter((r) => ['approved', 'pending', 'spam', 'removed'].includes(r.status)).length === rows.length
console.log(`comments with a legal status literal: ${statusOk ? 6 : '?'}  (expect 6)`)
checks.push(statusOk)

await p.$disconnect()

const bad = checks.filter((c) => !c).length
console.log(`\n${bad === 0 ? '✅ two-pass fixture VERIFIED' : `❌ ${bad} assertion(s) failed`}`)
if (bad !== 0) process.exit(1)
