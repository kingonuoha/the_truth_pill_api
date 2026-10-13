// ═════════════════════════════════════════════════════════════════════════════
// Phase 02 — enforced pre-flight export integrity check.  (P02-QA-002)
//
//   node --experimental-strip-types migration/verify-checksums.mts [zip]
//
//   zip defaults to $CONVEX_EXPORT_ZIP, then to the frozen snapshot path.
//
// WHAT IT DOES. Reads the frozen Convex export ZIP and, WITHOUT relying on the
// `extracted/` working copy, computes:
//   * the SHA-256 of the ZIP file itself, and
//   * the SHA-256 of each of the 21 `<table>/documents.jsonl` entries inside it,
//
// then compares both against the recorded expectation in
//   docs/phases/phase-02/phase02-audit/export-checksums.txt
// Exits 0 only if every hash and every row count matches; non-zero otherwise.
//
// WHY. QA raised P02-QA-002: the export was integrity-checked by hand and the
// result written down, but the importer never verified it, and the documented
// verifier did not exist in the repo. That made integrity *documented* but not
// *enforced*. This file is the enforcement. `import.mts` calls it before a REAL
// run, so a tampered or drifted export stops the import instead of silently
// landing bad rows.
//
// SECURITY. Never prints file contents. Hashes and counts only. The export is
// secret-bearing (a plaintext API key, emails, IPs, bcrypt hashes) and nothing
// it contains is echoed, even on a mismatch — only the expected and actual
// SHA-256, which are not reversible.
//
// ZIP READER. No dependency is used or added. The frozen snapshot is ZIP64 with
// streamed entries (general-purpose flag bit 3, i.e. sizes live in a trailing
// data descriptor), so the 32-bit size fields read 0xFFFFFFFF and the real
// values come from the 0x0001 ZIP64 extra field in the central directory. The
// `extracted/` copy is deliberately ignored: a check that trusts a mutable
// working copy proves nothing about the archive.
// ═════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The frozen production snapshot, taken `--prod` on 2026-09-29. Overridable. */
export const DEFAULT_ZIP =
  'C:/Users/Kingsley/AppData/Local/Temp/opencode/convex-prod-export/snapshot_gallant-loris-180_1790663640323327415.zip'

/** The recorded expectation, committed in the Phase 02 audit directory. */
export const DEFAULT_EXPECTED = resolve(
  HERE,
  '..',
  '..',
  'docs',
  'phases',
  'phase-02',
  'phase02-audit',
  'export-checksums.txt',
)

export type Expected = {
  /** table path → 16-char sha256 prefix recorded in export-checksums.txt */
  tables: Map<string, { hash16: string; rows: number }>
  zipSha256: string | null
  zipFileCount: number | null
  totalRows: number | null
}

export type FileResult = {
  path: string
  ok: boolean
  present: boolean
  rows: number
  gotPrefix: string
  wantPrefix: string
  gotFull: string
}

export type VerifyResult = {
  ok: boolean
  zipPath: string
  zipBytes: number
  zipSha256: string
  zipMatch: boolean | null
  zipWant: string | null
  files: FileResult[]
  okCount: number
  failCount: number
  totalRows: number
}

// ── the recorded expectation ─────────────────────────────────────────────────

export function parseExpected(text: string): Expected {
  const tables = new Map<string, { hash16: string; rows: number }>()
  let zipSha256: string | null = null
  let zipFileCount: number | null = null
  let totalRows: number | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const file = /^OK\s+(\S+)\s+rows=\s*(\d+)\s+([0-9a-f]{16})$/.exec(line)
    if (file) {
      tables.set(file[1], { hash16: file[3], rows: Number(file[2]) })
      continue
    }
    const zip = /^zip-sha256:\s*([0-9a-f]{64})$/.exec(line)
    if (zip) {
      zipSha256 = zip[1]
      continue
    }
    const count = /^zip-file-count:\s*(\d+)$/.exec(line)
    if (count) {
      zipFileCount = Number(count[1])
      continue
    }
    const total = /^total-rows:\s*(\d+)$/.exec(line)
    if (total) totalRows = Number(total[1])
  }
  return { tables, zipSha256, zipFileCount, totalRows }
}

// ── minimal ZIP64 reader (central-directory driven) ──────────────────────────

type ZipEntry = { name: string; method: number; csize: number; lo: number }

function readZipEntries(buf: Buffer): ZipEntry[] {
  const u16 = (o: number) => buf.readUInt16LE(o)
  const u32 = (o: number) => buf.readUInt32LE(o)

  // End Of Central Directory, scanning back over the (empty) comment.
  let eocd = -1
  const floor = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no End Of Central Directory record found')

  const total = u16(eocd + 10)
  const cdOffset = u32(eocd + 16)
  const entries: ZipEntry[] = []
  let p = cdOffset

  for (let i = 0; i < total; i++) {
    if (u32(p) !== 0x02014b50) throw new Error(`corrupt ZIP: bad central-directory signature at ${p}`)
    const method = u16(p + 10)
    let csize = u32(p + 20)
    let lo = u32(p + 42)
    const nlen = u16(p + 28)
    const elen = u16(p + 30)
    const clen = u16(p + 32)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    const extra = buf.subarray(p + 46 + nlen, p + 46 + nlen + elen)

    // ZIP64 extended information. The fields appear IN ORDER — uncompressed
    // size, compressed size, local-header offset — and only the ones whose
    // 32-bit slot is all-ones. Uncompressed size must be consumed FIRST even
    // though it is not needed, or every later field is read out of position.
    let xo = 0
    while (xo <= extra.length - 4) {
      const hid = extra.readUInt16LE(xo)
      const hsz = extra.readUInt16LE(xo + 2)
      if (hid === 0x0001) {
        let q = xo + 4
        const usize = u32(p + 24) // the 32-bit slot, to decide if it is present
        if (usize === 0xffffffff && q + 8 <= extra.length) q += 8
        if (csize === 0xffffffff && q + 8 <= extra.length) {
          csize = Number(extra.readBigUInt64LE(q))
          q += 8
        }
        if (lo === 0xffffffff && q + 8 <= extra.length) {
          lo = Number(extra.readBigUInt64LE(q))
          q += 8
        }
      }
      xo += 4 + hsz
    }
    entries.push({ name, method, csize, lo })
    p += 46 + nlen + elen + clen
  }
  return entries
}

function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const nlen = buf.readUInt16LE(entry.lo + 26)
  const elen = buf.readUInt16LE(entry.lo + 28)
  const start = entry.lo + 30 + nlen + elen
  const comp = buf.subarray(start, start + entry.csize)
  if (entry.method === 0) return Buffer.from(comp)
  if (entry.method === 8) return inflateRawSync(comp)
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`)
}

export function countRows(data: Buffer): number {
  if (data.length === 0) return 0
  return data.toString('utf8').split('\n').filter((l) => l.trim()).length
}

// ── the check ────────────────────────────────────────────────────────────────

export function verifyChecksums(
  zipPath: string = process.env.CONVEX_EXPORT_ZIP ?? DEFAULT_ZIP,
  expectedPath: string = DEFAULT_EXPECTED,
): VerifyResult {
  if (!existsSync(zipPath)) throw new Error(`export ZIP not found: ${zipPath}`)
  if (!existsSync(expectedPath)) throw new Error(`expected-checksum file not found: ${expectedPath}`)

  const expected = parseExpected(readFileSync(expectedPath, 'utf8'))
  if (expected.tables.size === 0) throw new Error(`no expected hashes parsed from ${expectedPath}`)

  const buf = readFileSync(zipPath)
  const zipSha256 = createHash('sha256').update(buf).digest('hex')
  const entries = readZipEntries(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))

  const files: FileResult[] = []
  let totalRows = 0

  for (const path of [...expected.tables.keys()].sort()) {
    const want = expected.tables.get(path)!
    const entry = byName.get(path)
    if (!entry) {
      files.push({
        path,
        ok: false,
        present: false,
        rows: 0,
        gotPrefix: 'ABSENT',
        wantPrefix: want.hash16,
        gotFull: '',
      })
      continue
    }
    const data = extractEntry(buf, entry)
    const full = createHash('sha256').update(data).digest('hex')
    const rows = countRows(data)
    totalRows += rows
    const ok = full.slice(0, 16) === want.hash16 && rows === want.rows
    files.push({
      path,
      ok,
      present: true,
      rows,
      gotPrefix: full.slice(0, 16),
      wantPrefix: want.hash16,
      gotFull: full,
    })
  }

  const okCount = files.filter((f) => f.ok).length
  const failCount = files.length - okCount
  const zipMatch = expected.zipSha256 ? expected.zipSha256 === zipSha256 : null

  return {
    ok: failCount === 0 && zipMatch !== false && files.length === expected.tables.size,
    zipPath,
    zipBytes: buf.length,
    zipSha256,
    zipMatch,
    zipWant: expected.zipSha256,
    files,
    okCount,
    failCount,
    totalRows,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Human-readable report — the exact format of `export-checksums.txt`. */
export function renderReport(r: VerifyResult, expected = parseExpected(readFileSync(DEFAULT_EXPECTED, 'utf8'))): string {
  const lines: string[] = []
  for (const f of r.files) {
    if (!f.ok) {
      lines.push(
        `DIFF  ${f.present ? f.path : `${f.path} (ABSENT)`}`.padEnd(6 + 34) +
          `rows=${String(f.rows).padStart(5)}`,
      )
      if (f.present) {
        lines.push(`      got      ${f.gotFull}`)
        lines.push(`      expected ${f.wantPrefix}  (recorded prefix; want rows ${expected.tables.get(f.path)?.rows})`)
      }
    } else {
      lines.push(`OK    ${f.path.padEnd(34)} rows=${String(f.rows).padStart(5)}  ${f.gotPrefix}`)
    }
  }
  lines.push('')
  lines.push(`zip-sha256: ${r.zipSha256}`)
  if (r.zipMatch === false) lines.push(`zip-expected:  ${r.zipWant}`)
  lines.push(`zip-file-count: ${r.files.length}`)
  lines.push(`total-rows: ${r.totalRows}`)
  lines.push(`checksum-match: ${r.okCount}/${r.files.length} OK, ${r.failCount} FAIL`)
  if (r.zipMatch === true) lines.push('zip-hash: OK')
  if (r.zipMatch === false) lines.push('zip-hash: FAIL')
  return lines.join('\n')
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirect) {
  const zipPath = process.argv[2] ?? process.env.CONVEX_EXPORT_ZIP ?? DEFAULT_ZIP
  // argv[3] / $CONVEX_EXPORT_CHECKSUMS_FILE override the expectation file,
  // which exists so a negative control can assert that a wrong hash FAILS.
  const expectedPath = process.argv[3] ?? process.env.CONVEX_EXPORT_CHECKSUMS_FILE ?? DEFAULT_EXPECTED
  try {
    if (existsSync(zipPath)) console.error(`export ZIP: ${zipPath}  (${statSync(zipPath).size} bytes)`)
    console.error(`expected:   ${expectedPath}`)
    const r = verifyChecksums(zipPath, expectedPath)
    console.log(renderReport(r, parseExpected(readFileSync(expectedPath, 'utf8'))))
    if (!r.ok) {
      console.error(`\n❌ export integrity check FAILED — ${r.failCount} file(s) differ${r.zipMatch === false ? ' (and the ZIP hash differs)' : ''}`)
      process.exitCode = 1
    } else {
      console.error(`\n✅ export integrity check PASSED — ${r.okCount}/${r.files.length} files, ${r.totalRows} rows, ZIP hash match`)
    }
  } catch (err) {
    console.error(`❌ export integrity check could not run: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
