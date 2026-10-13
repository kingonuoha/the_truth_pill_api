// ═════════════════════════════════════════════════════════════════════════════
// Phase 02 — import library
//
// Standalone, streamed, batched Convex → Postgres importer. NOT part of the
// Nest application (Phase 04); it lives in `api/migration/` with its own
// package scripts.
//
// WHAT IT DOES, IN ORDER
//   1. streams `<table>/documents.jsonl` line by line (never a whole table)
//   2. derives a DETERMINISTIC uuid per source `_id` (sha256, no Math.random)
//   3. resolves every relation through a persisted oldId -> newId map
//   4. quarantines rows it cannot insert, with a reason, and never aborts the
//      batch silently
//   5. inserts with `createMany` in ~1,000-row batches, `skipDuplicates`
//   6. recomputes the DEV-021 / DEV-022 caches in ONE $transaction
//
// SECURITY CONTRACT (AGENTS.md rule 8, checks.md "read this first" §3)
//   This file must never emit a secret-bearing VALUE. Emitted: counts, lengths,
//   booleans, table names, file names, reasons. Never: emails, IPs, bcrypt
//   hashes, the AI key, password hashes, connection strings, or a whole
//   quarantined document. `aiSettings.apiKey` is copied field-for-field and
//   asserted with a non-logging equality that prints LENGTH ONLY (DEV-015).
//
// ADR-008 (idempotency) — deterministic ids + `skipDuplicates` means a re-run
// inserts 0 rows and exits 0. Nothing here uses `prisma migrate dev`.
// ═════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '../src/generated/prisma/client.ts'
import { PrismaNeon } from '@prisma/adapter-neon'
import { Prisma } from '../src/generated/prisma/client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const API_ROOT = resolve(HERE, '..')

// ── Configuration ───────────────────────────────────────────────────────────

export const CFG = {
  /** Frozen Convex production export root. Never inside the repo. */
  exportRoot:
    process.env.PHASE02_EXPORT_ROOT ??
    'C:/Users/Kingsley/AppData/Local/Temp/opencode/convex-prod-export/extracted',
  /** B4 — ~1,000 rows per createMany. Tunable from the environment. */
  batchSize: Number(process.env.PHASE02_BATCH_SIZE ?? 1000),
  idMapPath: join(HERE, 'id-map.json'),
  quarantineRoot: join(HERE, 'quarantine'),
  dryRunQuarantineRoot: join(HERE, 'quarantine-dryrun'),
  /** B2 — the id-map must hold exactly this many entries after the import. */
  expectedIdMapEntries: 5877,
}

// ── env (parsed directly; values are NEVER printed) ──────────────────────────

export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const p = join(API_ROOT, '.env')
  if (!existsSync(p)) {
    throw new Error('api/.env is missing. Stop — never reconstruct a connection string.')
  }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL absent from api/.env')
  if (!env.DIRECT_URL) throw new Error('DIRECT_URL absent from api/.env')
  return env
}

let _prisma: PrismaClient | null = null
export function prisma(): PrismaClient {
  if (_prisma) return _prisma
  const env = loadEnv()
  // ADR-003: DATABASE_URL is the POOLED host. Runtime queries only, never DDL.
  _prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: env.DATABASE_URL }) })
  return _prisma
}

export async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect()
    _prisma = null
  }
}

// ── Deterministic uuid (B: "Deterministic UUID input: seed from oldId") ─────
//
// `@default(uuid(7))` is long gone; the importer supplies ids. Seeding from the
// source `_id` with SHA-256 makes the map reproducible: the same export always
// yields the same database, which is what ADR-008 requires. `Math.random()` is
// banned — there is a grep for it in the phase gate.

export function detUuid(oldId: string): string {
  const h = createHash('sha256').update('truthpill:migration:v1:' + oldId).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const s = b.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── Singletons: fixed literal ids, so re-running is an upsert (schema.ts) ───

export const SINGLETON_IDS: Record<string, string> = {
  globalStats: 'global_stats',
  aiSettings: 'ai_settings',
  adsSettings: 'ads_settings',
  siteSettings: 'site_settings',
}

// ── id-map (B2) ─────────────────────────────────────────────────────────────

export type IdMap = Map<string, string>

export function loadIdMap(path = CFG.idMapPath): { map: IdMap; reused: boolean } {
  if (!existsSync(path)) return { map: new Map(), reused: false }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  return { map: new Map(Object.entries(raw)), reused: true }
}

export function saveIdMap(map: IdMap, path = CFG.idMapPath): number {
  const obj: Record<string, string> = {}
  for (const k of Array.from(map.keys()).sort()) obj[k] = map.get(k)!
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 0) + '\n', 'utf8')
  return Object.keys(obj).length
}

// ── Quarantine (B12) ────────────────────────────────────────────────────────
//
// One file per (table, reason). Contents are MINIMAL: enough to audit the
// decision and reverse it, and nothing more. The DEV-023 rows ARE imported
// (with pillar NULL) — only the rejected VALUE is quarantined, never the article
// body. DEV-025 rows are NOT imported, so the full source document is kept
// (checks.md §5: "the decision is auditable and reversible"); that document
// holds only _id / articleId / viewedAt / visitorId / engagementTime.

export type QuarantineRoot = string

export function initQuarantine(root: QuarantineRoot) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
}

export function quarantine(root: QuarantineRoot, table: string, reason: string, record: unknown) {
  const dir = join(root, table)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${reason}.jsonl`), JSON.stringify(record) + '\n', 'utf8')
}

export function listQuarantine(root: QuarantineRoot): { file: string; rows: number }[] {
  if (!existsSync(root)) return []
  const out: { file: string; rows: number }[] = []
  for (const table of readdirSafe(root)) {
    const tdir = join(root, table)
    for (const f of readdirSafe(tdir)) {
      const lines = readFileSync(join(tdir, f), 'utf8').split('\n').filter((l) => l.trim().length)
      out.push({ file: `${table}/${f}`, rows: lines.length })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

function readdirSafe(p: string): string[] {
  if (!existsSync(p)) return []
  return readdirSync(p)
}

// ── Streamed JSONL reader (B3) ───────────────────────────────────────────────
//
// Line-at-a-time. A per-line parse failure is captured as a quarantine row with
// a reason, and the reader CONTINUES — a malformed row must never silently drop
// a batch.

export type ReadResult = { doc: any | null; lineNo: number; error: string | null }

function parseLine(line: string): { doc: any | null; error: string | null } {
  try {
    return { doc: JSON.parse(line), error: null }
  } catch (e) {
    return { doc: null, error: `json_parse_failed: ${(e as Error).message.slice(0, 120)}` }
  }
}

export async function * streamTable(root: string, table: string): AsyncGenerator<ReadResult> {
  const p = join(root, table, 'documents.jsonl')
  if (!existsSync(p)) return
  const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    if (!line.trim().length) continue
    const parsed = parseLine(line)
    yield { doc: parsed.doc, lineNo, error: parsed.error }
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Convex stores epoch millis as a JSON number. */
export const ts = (v: unknown): Date | null =>
  typeof v === 'number' ? new Date(v) : v === undefined || v === null ? null : new Date(v as string)

/** Convex OMITS an absent optional field. Postgres arrays must never be NULL. */
export const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : [])

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/** `Json?` columns: an absent or null Convex value is SQL NULL, not JSON null. */
export const jsonOrDbNull = (v: unknown): unknown =>
  v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue)

/** @db.Date from a `YYYY-MM-DD` string. */
export const dateOnly = (v: string): Date => new Date(v + 'T00:00:00.000Z')

// ── Transform registry ───────────────────────────────────────────────────────
//
// One entry per table. `order` is FK-safe: a table never appears before
// something it points at.

export type Ctx = {
  idMap: IdMap
  pillarSlugs: Set<string>
  table: string
}

export type TransformOutcome = {
  data: Record<string, unknown> | null
  /** reason slug -> the record to write into quarantine/ */
  quarantine?: { reason: string; record: unknown }
}

export type Transform = (doc: any, ctx: Ctx) => TransformOutcome

const TABLES: { name: string; fn: Transform; singleton?: boolean }[] = [
  {
    name: 'users',
    fn: (d, ctx) => {
      const id = ctx.idMap.get(d._id)!
      return {
        data: {
          id,
          name: d.name,
          email: d.email, // B7 — byte-identical, never normalised
          password: str(d.password), // B8 — bcrypt copied VERBATIM, never re-hashed
          profileImage: str(d.profileImage),
          provider: d.provider,
          role: d.role as any,
          emailVerified: typeof d.emailVerified === 'boolean' ? d.emailVerified : null,
          newsletterSubscribed:
            typeof d.newsletterSubscribed === 'boolean' ? d.newsletterSubscribed : false,
          emailConfirmed: typeof d.emailConfirmed === 'boolean' ? d.emailConfirmed : null,
          confirmationToken: str(d.confirmationToken),
          resetToken: str(d.resetToken),
          resetTokenExpires: ts(d.resetTokenExpires),
          completedTours: arr<string>(d.completedTours), // DEV-026
          createdAt: ts(d.createdAt)!,
        },
      }
    },
  },
  {
    name: 'categories',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        name: d.name,
        slug: d.slug, // B6 — public URL segment, byte-identical
        description: str(d.description),
        coverImage: str(d.coverImage),
        pexelsImages: arr<string>(d.pexelsImages),
        articleCount: num(d.articleCount) ?? 0, // overwritten by the DEV-022 recompute
        createdAt: ts(d.createdAt)!,
      },
    }),
  },
  {
    name: 'pillars',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        name: d.name,
        slug: d.slug, // B6
        description: str(d.description),
        coverImage: str(d.coverImage),
        pexelsImages: arr<string>(d.pexelsImages),
        categoryId: ctx.idMap.get(d.categoryId)!,
        createdAt: ts(d.createdAt)!,
      },
    }),
  },
  {
    name: 'articles',
    // DEV-023 — `pillar` is a bare string in Convex and 5 production rows hold a
    // value that matches no pillars.slug (3 x "", 2 x "Human Behaviour"). The
    // import NULLs the value and quarantines it. NO pillars row is minted to
    // absorb them.
    fn: (d, ctx) => {
      const data: Record<string, unknown> = {
        id: ctx.idMap.get(d._id)!,
        title: d.title,
        slug: d.slug, // B6
        excerpt: str(d.excerpt),
        content: str(d.content),
        coverImage: str(d.coverImage),
        coverImageAlt: str(d.coverImageAlt),
        authorId: ctx.idMap.get(d.authorId)!,
        categoryId: d.categoryId ? ctx.idMap.get(d.categoryId)! : null,
        topics: arr<string>(d.topics),
        tags: arr<string>(d.tags), // DEV-026 — 2 rows omit the key
        type: (d.type ?? null) as any,
        status: d.status as any,
        source: d.source as any,
        scheduledFor: ts(d.scheduledFor),
        publishedAt: ts(d.publishedAt),
        // DEV-016 — copied VERBATIM. logArticleView is a 24h-cooldown upsert, not
        // an event log, so the raw tables cannot reproduce a lifetime total.
        viewCount: num(d.viewCount) ?? 0,
        uniqueViewCount: num(d.uniqueViewCount) ?? 0,
        // DEV-021 — copied here, then RECOMPUTED from the reactions table in the
        // single $transaction. The stored value is stale (always 0).
        reactionsCount: num(d.reactionsCount) ?? 0,
        readingTime: num(d.readingTime) ?? 0,
        actualReadingTime: num(d.actualReadingTime),
        metaTitle: str(d.metaTitle),
        metaDescription: str(d.metaDescription),
        focusKeyword: str(d.focusKeyword),
        createdAt: ts(d.createdAt)!,
        updatedAt: ts(d.updatedAt)!,
        isFeatured: typeof d.isFeatured === 'boolean' ? d.isFeatured : null,
        isArchived: typeof d.isArchived === 'boolean' ? d.isArchived : null,
        pillar: str(d.pillar),
      }
      const out: TransformOutcome = { data }
      if (data.pillar !== null && !ctx.pillarSlugs.has(data.pillar as string)) {
        data.pillar = null
        out.quarantine = {
          reason: 'DEV-023-invalid-pillar',
          // The article IS imported. Only the rejected value is quarantined —
          // the body is not duplicated into this directory.
          record: {
            table: 'articles',
            reason: 'DEV-023-invalid-pillar',
            detail: 'pillar value matches no pillars.slug; imported with pillar = NULL',
            sourceId: d._id,
            newId: ctx.idMap.get(d._id)!,
            pillar: d.pillar,
          },
        }
      }
      return out
    },
  },
  {
    name: 'comments',
    // ADR-008 — two passes. parentId is resolved in pass 2 from the id-map, so
    // insert order never matters and nesting depth is unbounded.
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        articleId: ctx.idMap.get(d.articleId)!,
        userId: ctx.idMap.get(d.userId)!,
        parentId: null, // pass 2
        content: d.content,
        status: d.status as any,
        createdAt: ts(d.createdAt)!,
      },
      __parentSource: d.parentId ?? null,
    } as any),
  },
  {
    name: 'reactions',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        articleId: ctx.idMap.get(d.articleId)!,
        userId: ctx.idMap.get(d.userId)!,
        type: d.type as any,
        createdAt: ts(d.createdAt)!,
      },
    }),
  },
  {
    name: 'bookmarks',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        articleId: ctx.idMap.get(d.articleId)!,
        userId: ctx.idMap.get(d.userId)!,
        createdAt: ts(d.createdAt)!,
      },
    }),
  },
  {
    name: 'pageVisits',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        visitorId: d.visitorId,
        userId: d.userId ? ctx.idMap.get(d.userId)! : null, // DEV-024 — Text ipAddress, verbatim
        url: d.url,
        ipAddress: d.ipAddress, // client-controlled; never normalised, never printed
        geoLocation: jsonOrDbNull(d.geoLocation),
        device: d.device,
        browser: d.browser,
        os: d.os,
        referrer: str(d.referrer),
        timestamp: ts(d.timestamp)!,
      },
    }),
  },
  {
    name: 'visitorTracking',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        trackingCode: d.trackingCode,
        userId: d.userId ? ctx.idMap.get(d.userId)! : null,
        firstVisit: ts(d.firstVisit)!,
        lastVisit: ts(d.lastVisit)!,
        totalVisits: num(d.totalVisits) ?? 0,
      },
    }),
  },
  {
    name: 'dailyStats',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        date: dateOnly(d.date),
        visits: num(d.visits) ?? 0,
        uniqueVisitors: num(d.uniqueVisitors) ?? 0,
        lastRollup: ts(d.lastRollup),
      },
    }),
  },
  {
    name: 'aiSchedule',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        daysOfWeek: arr<number>(d.daysOfWeek),
        time: d.time,
        timezone: d.timezone,
        isActive: typeof d.isActive === 'boolean' ? d.isActive : false,
        lastRun: ts(d.lastRun),
        topicsToResearch: arr<string>(d.topicsToResearch),
        nextRun: ts(d.nextRun),
      },
    }),
  },
  {
    name: 'aiSettings',
    // DEV-015 (corrected 2026-09-30) — the key is COPIED BYTE-IDENTICALLY.
    // Kingsley's decision (AGENTS.md, decisions.md, overview.md launch item 1):
    // the plaintext exposure already exists in Convex and in the export, so
    // porting it adds no new class of risk; nulling it would only break AI
    // features. Rotation is the remedy, at Phase 13.
    // The equality assertion below prints LENGTH ONLY. The value appears in
    // exactly two places: the source line and the target column.
    fn: (d, ctx) => {
      const data = {
        id: ctx.idMap.get(d._id)!,
        provider: d.provider,
        apiKey: str(d.apiKey),
        model: d.model,
        promptTemplate: str(d.promptTemplate),
        isActive: typeof d.isActive === 'boolean' ? d.isActive : false,
        lastTested: ts(d.lastTested),
        testStatus: (d.testStatus ?? null) as any,
        isWriting: ts(d.isWriting),
        createdAt: ts(d.createdAt),
      }
      // Non-logging byte-identity assertion. It compares, and reports a boolean
      // plus a length. It cannot print the value even if it wanted to.
      const src = str(d.apiKey)
      const dst = str(data.apiKey)
      const identical = src === dst
      const declared = `length ${src ? src.length : 0}, provider ${d.provider}, byte-identical ${identical ? 'true' : 'false'}`
      if (src !== null && !identical) {
        throw new Error('DEV-015: apiKey was transformed in flight. STOP and inspect the transform.')
      }
      return { data, __apiKeyAssertion: declared } as any
    },
  },
  {
    name: 'articleViews',
    // DEV-025 — exactly one export row points at an article that is absent from
    // the ENTIRE export. Postgres cannot store that with a real FK. The row is
    // quarantined, NOT inserted, and NOT deleted: the original is preserved so
    // the decision stays auditable and reversible.
    fn: (d, ctx) => {
      if (!ctx.idMap.has(d.articleId)) {
        return {
          data: null,
          quarantine: {
            reason: 'DEV-025-dangling-article',
            record: {
              _id: d._id,
              articleId: d.articleId,
              viewedAt: d.viewedAt,
              visitorId: d.visitorId,
              engagementTime: d.engagementTime ?? null,
              _creationTime: d._creationTime ?? null,
            },
          },
        }
      }
      return {
        data: {
          id: ctx.idMap.get(d._id)!,
          articleId: ctx.idMap.get(d.articleId)!,
          visitorId: d.visitorId,
          userId: d.userId ? ctx.idMap.get(d.userId)! : null,
          viewedAt: ts(d.viewedAt)!,
          engagementTime: num(d.engagementTime),
        },
      }
    },
  },
  {
    name: 'emailQueue',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        recipient: d.recipient,
        subject: d.subject,
        templateName: d.templateName,
        templateData: jsonOrDbNull(d.templateData) as Prisma.InputJsonValue,
        status: d.status as any,
        scheduledFor: ts(d.scheduledFor)!,
        sentAt: ts(d.sentAt),
        error: str(d.error),
        retries: num(d.retries) ?? 0,
      },
    }),
  },
  {
    name: 'researchTopics',
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        topic: d.topic,
        categoryId: d.categoryId ? ctx.idMap.get(d.categoryId)! : null,
        status: d.status as any,
        createdAt: ts(d.createdAt)!,
      },
    }),
  },
  { name: 'quotes', fn: (d, ctx) => ({ data: { id: ctx.idMap.get(d._id)!, text: d.text, author: d.author, category: str(d.category), createdAt: ts(d.createdAt)! } }) },
  { name: 'otpCodes', fn: (d, ctx) => ({ data: { id: ctx.idMap.get(d._id)!, email: d.email, code: d.code, type: d.type as any, expiresAt: ts(d.expiresAt)! } }) },
  {
    name: 'adsSettings',
    singleton: true,
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        adsEnabled: typeof d.adsEnabled === 'boolean' ? d.adsEnabled : false,
        adsenseScriptCode: d.adsenseScriptCode,
        adsenseAdUnitCode: d.adsenseAdUnitCode,
        showAdTopOfArticle: typeof d.showAdTopOfArticle === 'boolean' ? d.showAdTopOfArticle : false,
        showAdMiddleOfArticle: typeof d.showAdMiddleOfArticle === 'boolean' ? d.showAdMiddleOfArticle : false,
        showAdBottomOfArticle: typeof d.showAdBottomOfArticle === 'boolean' ? d.showAdBottomOfArticle : false,
        showAdSidebar: typeof d.showAdSidebar === 'boolean' ? d.showAdSidebar : false,
        updatedAt: ts(d.updatedAt)!,
      },
    }),
  },
  {
    name: 'siteSettings',
    singleton: true,
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        siteName: d.siteName,
        siteDescription: d.siteDescription,
        email: d.email,
        phone: str(d.phone),
        address: str(d.address),
        socials: jsonOrDbNull(d.socials) as Prisma.InputJsonValue,
        footerText: str(d.footerText),
        updatedAt: ts(d.updatedAt)!,
      },
    }),
  },
  {
    name: 'globalStats',
    singleton: true,
    // Every counter is copied here and then RECOMPUTED in one $transaction.
    // The stored values drifted: articleCount +3, totalViews +2,846 (DEV-022).
    fn: (d, ctx) => ({
      data: {
        id: ctx.idMap.get(d._id)!,
        articleCount: num(d.articleCount) ?? 0,
        publishedArticleCount: num(d.publishedArticleCount) ?? 0,
        draftArticleCount: num(d.draftArticleCount) ?? 0,
        scheduledArticleCount: num(d.scheduledArticleCount) ?? 0,
        aiDraftCount: num(d.aiDraftCount) ?? 0,
        usersCount: num(d.usersCount) ?? 0,
        commentsCount: num(d.commentsCount) ?? 0,
        pendingCommentsCount: num(d.pendingCommentsCount) ?? 0,
        totalViews: num(d.totalViews) ?? 0,
        totalUniqueViews: num(d.totalUniqueViews) ?? 0,
        updatedAt: new Date(),
      },
    }),
  },
]

export const TRANSFORMS = TABLES
export const EXPORT_TABLES = TABLES.map((t) => t.name)

/** The only two approved quarantine classes in this import. */
export const APPROVED_REASONS = ['DEV-023-invalid-pillar', 'DEV-025-dangling-article']

/**
 * ID-GATE (B2) — a quarantined row must NOT receive a new id, or the id-map
 * grows past 5,877 and a re-run would try to insert a row that is deliberately
 * absent. Exactly one table has such a row: `articleViews`, where DEV-025
 * quarantines a view whose article is absent from the entire export.
 *
 * `articles` must therefore be resolved BEFORE `articleViews` walks its rows,
 * which the import order already guarantees (articles is 4th, articleViews 13th).
 */
export const ID_GATE: Record<string, (doc: any, idMap: IdMap) => boolean> = {
  articleViews: (doc, idMap) => idMap.has(doc.articleId),
}

/**
 * TABLE -> Prisma model accessor (Prisma 7 `prisma-client` generator).
 *
 * The generator exposes SINGULAR accessors (`db.user`, `db.article`,
 * `db.pageVisit`) while the export and the SQL schema use PLURAL table names
 * (`users`, `articles`, `pageVisits`). Guessing one from the other is wrong for
 * 14 of the 20 tables, so the mapping is declared once here and asserted
 * against the live client in `assertModelMap()` — an unmapped table is a hard
 * STOP, never a skipped insert.
 */
export const MODEL: Record<string, string> = {
  globalStats: 'globalStats',
  users: 'user',
  quotes: 'quote',
  articles: 'article',
  categories: 'category',
  comments: 'comment',
  reactions: 'reaction',
  bookmarks: 'bookmark',
  pageVisits: 'pageVisit',
  visitorTracking: 'visitorTracking',
  dailyStats: 'dailyStat',
  aiSchedule: 'aiSchedule',
  aiSettings: 'aiSettings',
  articleViews: 'articleView',
  emailQueue: 'emailQueue',
  researchTopics: 'researchTopic',
  adsSettings: 'adsSettings',
  siteSettings: 'siteSettings',
  otpCodes: 'otpCode',
  pillars: 'pillar',
}

/** Fail loudly rather than silently importing 6 tables out of 20. */
export function assertModelMap(db: unknown): void {
  const client = db as Record<string, unknown>
  const problems: string[] = []
  for (const table of EXPORT_TABLES) {
    const name = MODEL[table]
    if (!name) problems.push(`${table}: no entry in MODEL`)
    else if (!client[name]) problems.push(`${table}: client has no accessor '${name}'`)
  }
  const extra = Object.keys(MODEL).filter((t) => !EXPORT_TABLES.includes(t))
  for (const t of extra) problems.push(`${t}: MODEL entry for a table that is not in the import`)
  if (problems.length) {
    console.error('*** STOP: Prisma model map is out of date:')
    for (const p of problems) console.error(`    ${p}`)
    process.exit(1)
  }
}

/** Resolve the model delegate for a table, or STOP. Never returns undefined. */
export function model(db: unknown, table: string): any {
  const delegate = (db as Record<string, unknown>)[MODEL[table]]
  if (!delegate) {
    console.error(`*** STOP: no Prisma delegate for table '${table}'`)
    process.exit(1)
  }
  return delegate
}


// ── Pass 1 / pass 2 plumbing for the self-referencing table (ADR-008) ───────

export type TableReport = {
  table: string
  read: number
  /** Rows held back from the import entirely (DEV-025). */
  quarantined: number
  /** Values quarantined while the row itself was still imported (DEV-023). */
  valuesQuarantined: number
  eligible: number
  alreadyPresent: number
  inserted: number
  batches: number
  batchSizes: number[]
  reasons: Record<string, number>
}

export function newReport(table: string): TableReport {
  return { table, read: 0, quarantined: 0, valuesQuarantined: 0, eligible: 0, alreadyPresent: 0, inserted: 0, batches: 0, batchSizes: [], reasons: {} }
}

/** Tally a reason against a table report. Does NOT touch the row counters. */
export function bump(r: TableReport, reason: string) {
  r.reasons[reason] = (r.reasons[reason] ?? 0) + 1
}
