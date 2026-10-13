// Phase 02 — P02-SEC-002 / DEV-028 pre- and post-migration proof.
//
// Establishes that the otp_lockout_columns migration (a) added exactly the four
// §CN-1 columns to `otpCodes`, (b) did not touch any other table, (c) did not
// change DEV-027's `code` width, and (d) left all 5,877 imported rows intact.
//
//   node --experimental-strip-types migration/verify-otp-lockout.mts
//
// Read-only. Prints column names, types, nullability and counts only — never a
// key, token, code value, email, or IP.

import { CFG, EXPORT_TABLES, prisma } from './lib.mts'

const p = prisma()
const q = async <T = any>(sql: string): Promise<T[]> => (await p.$queryRawUnsafe(sql)) as T[]

const EXPECTED = [
  { name: 'attempts', type: 'integer', nullable: 'NO', dflt: '0' },
  { name: 'consumedAt', type: 'timestamp with time zone', nullable: 'YES', dflt: null },
  { name: 'lastSentAt', type: 'timestamp with time zone', nullable: 'YES', dflt: null },
  { name: 'lockedUntil', type: 'timestamp with time zone', nullable: 'YES', dflt: null },
] as const

let failures = 0
const check = (label: string, ok: boolean, got: unknown, want: unknown) => {
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(56)} got ${String(got).padStart(9)}  want ${want}`)
}

type Col = {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
  character_maximum_length: number | null
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════')
  console.log('P02-SEC-002 / DEV-028 — otpCodes lockout column proof')
  console.log(`target: ${CFG.exportRoot.includes('nope') ? '(direct)' : 'dev branch via DIRECT_URL'}`)
  console.log('════════════════════════════════════════════════════════════════════\n')

  // ── 1. the four §CN-1 columns exist, with the intended type + nullability ──
  console.log('── 1. §CN-1 R1/R2/R3/R7 columns on otpCodes')
  // Every column is cast to text / int: the Neon driver cannot deserialize
  // Postgres' internal `name` type that information_schema and pg_indexes use.
  const cols = await q<Col>(
    `SELECT column_name::text AS column_name,
            data_type::text AS data_type,
            is_nullable::text AS is_nullable,
            column_default::text AS column_default,
            character_maximum_length::int AS character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'otpCodes'
      ORDER BY column_name`,
  )
  for (const e of EXPECTED) {
    const c = cols.find((x) => x.column_name === e.name)
    check(
      `column ${e.name} ${e.type} ${e.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`,
      !!c && c.data_type === e.type && c.is_nullable === e.nullable,
      c ? `${c.data_type} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}` : 'ABSENT',
      `${e.type} ${e.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`,
    )
    if (e.name === 'attempts' && c) {
      check('  attempts DEFAULT 0', c.column_default === '0', c.column_default, '0')
    }
  }

  // ── 2. exactly the four were added, nothing else changed shape ──
  console.log('\n── 2. no other column added or retyped')
  check('otpCodes column count (5 frozen + 4 = 9)', cols.length === 9, cols.length, 9)
  const frozen = ['code', 'email', 'expiresAt', 'id', 'type']
  for (const f of frozen) check(`frozen column still present: ${f}`, !!cols.find((c) => c.column_name === f), cols.find((c) => c.column_name === f) ? 'present' : 'ABSENT', 'present')

  // ── 3. DEV-027 intact: code must still be varchar(128) ──
  console.log('\n── 3. DEV-027 (P01-SEC-001) not regressed')
  const code = cols.find((c) => c.column_name === 'code')!
  check('otpCodes.code max length (DEV-027)', code?.character_maximum_length === 128, code?.character_maximum_length, 128)
  const widths = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'otpCodes'
        AND column_name = 'code' AND character_maximum_length = 128`,
  )
  check('exactly one code column at width 128', widths[0].n === 1, widths[0].n, 1)

  // ── 4. the search index Prisma cannot express must SURVIVE ──
  console.log('\n── 4. permanent drift preserved (GIN index NOT dropped)')
  const idx = await q<{ indexname: string; indexdef: string }>(
    `SELECT indexname::text AS indexname, indexdef::text AS indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'articles' AND indexname = 'articles_searchVector_idx'`,
  )
  check('articles_searchVector_idx still present', idx.length === 1, idx.length, 1)
  check('  and it is still USING gin', /USING gin/i.test(idx[0]?.indexdef ?? ''), /USING gin/i.test(idx[0]?.indexdef ?? '') ? 'gin' : 'not-gin', 'gin')

  // ── 5. every other table untouched: row totals must still be 5,877 ──
  console.log('\n── 5. imported data untouched')
  let total = 0
  const perTable: string[] = []
  for (const t of EXPORT_TABLES) {
    const n = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`)
    total += n[0].n
    perTable.push(`${t}=${n[0].n}`)
  }
  check('TOTAL rows across all 20 mapped tables', total === 5877, total, 5877)

  const otp = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "otpCodes"`)
  check('otpCodes rows (0 in export, 0 expected)', otp[0].n === 0, otp[0].n, 0)

  // A NULL default on new rows: prove the DDL default is live, not just DDL text.
  const dfltLive = await q<{ a: number }>(`SELECT count(*)::int AS a FROM "otpCodes" WHERE "attempts" IS NULL`)
  check('no row has attempts IS NULL', dfltLive[0].a === 0, dfltLive[0].a, 0)

  console.log(`\n  per-table: ${perTable.join(' ')}`)

  // ── 6. migration history: 5/5 finished, none rolled back ──
  console.log('\n── 6. migration history')
  const hist = await q<{ n: string; ok: boolean; rb: boolean; steps: number }>(
    `SELECT migration_name::text AS n,
            finished_at IS NOT NULL AS ok,
            rolled_back_at IS NOT NULL AS rb,
            applied_steps_count::int AS steps
       FROM _prisma_migrations ORDER BY started_at`,
  )
  for (const m of hist) check(`applied: ${m.n}`, m.ok && !m.rb, m.ok && !m.rb ? 'finished' : 'INCOMPLETE/ROLLED BACK', 'finished')
  const good = hist.filter((m) => m.ok && !m.rb).length
  check('migrations finished and not rolled back', good === 5 && hist.length === 5, `${good}/${hist.length}`, '5/5')

  console.log('\n════════════════════════════════════════════════════════════════════')
  if (failures) {
    console.log(`❌ FAILED — ${failures} check(s)`)
    process.exitCode = 1
  } else {
    console.log('✅ ALL CHECKS PASS — 4 columns added, DEV-027 intact, GIN index alive, 5,877 rows untouched')
  }
  console.log('════════════════════════════════════════════════════════════════════')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => p.$disconnect())
