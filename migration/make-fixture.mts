// Two-pass fixture generator (ADR-008 self-reference).
//
// The production export has ZERO comments, so `comments.parentId` is the one
// import path the real data never exercises. This builds a synthetic 3-level
// thread and hands it to the REAL pipeline, which must insert every row in pass
// 1 (parentId NULL) and resolve the references in pass 2.
//
// The children are written BEFORE their parents on purpose: a single-pass
// importer would leave them orphaned, which is exactly the bug being tested.
//
//   f1 (root)
//    └─ f2 ─ f3 (grandchild, parent written earlier in the file)
//   f4 (root)
//    └─ f5 (child of f4)
//
// Also includes f6 whose parentId points at a comment that does NOT exist, to
// prove the pass-2 statement skips an unresolvable reference instead of
// aborting the batch.

import { mkdirSync, writeFileSync } from 'node:fs'
import { CFG, streamTable } from './lib.mts'

// Borrow a real article and a real user so the foreign keys resolve.
let articleId: string | null = null
let userId: string | null = null
for await (const { doc } of streamTable(CFG.exportRoot, 'articles')) {
  if (doc && !articleId) articleId = doc._id
}
for await (const { doc } of streamTable(CFG.exportRoot, 'users')) {
  if (doc && !userId) userId = doc._id
}
if (!articleId || !userId) {
  console.error('*** STOP: could not find an article and a user in the export to anchor the fixture')
  process.exit(1)
}

// Field-for-field from web/convex/schema.ts comments:defineTable — no more, no
// less. createdAt is v.float64() (epoch ms), status is the 4-literal union.
const t = 1750000000000 // fixed epoch ms — the fixture must be byte-reproducible
const row = (id: string, parent: string | null, text: string, status: string) => ({
  _id: id,
  articleId,
  userId,
  parentId: parent,
  content: text,
  status,
  createdAt: t,
})

const rows = [
  // child written BEFORE its parent — a single-pass importer orphans f3
  row('fixture-f3-grandchild', 'fixture-f2-child', 'grandchild of f2', 'approved'),
  row('fixture-f2-child', 'fixture-f1-root', 'child of f1', 'approved'),
  row('fixture-f1-root', null, 'root comment', 'approved'),
  row('fixture-f5-child-of-f4', 'fixture-f4-root', 'child of f4', 'pending'),
  row('fixture-f4-root', null, 'second root comment', 'approved'),
  // dangling parent reference — must be skipped by pass 2, not fatal
  row('fixture-f6-orphan-candidate', 'fixture-does-not-exist', 'parent will not resolve', 'removed'),
]

const dir = new URL('./.fixture/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(dir, { recursive: true })
const file = dir + 'two-pass-comments.jsonl'
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

console.log(`fixture written: ${file}`)
console.log(`rows: ${rows.length} (3-level tree f1>f2>f3, second tree f4>f5, 1 dangling parent f6)`)
console.log(`anchored to a real article and a real user from the export`)
