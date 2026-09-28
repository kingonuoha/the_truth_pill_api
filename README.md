# api/ — NestJS Backend (The Truth Pill)

**Status:** Not yet scaffolded. Built in Phase 04.
**Owner:** `truth-pill-backend` agent
**Deploy target:** Render Web Service + Render Background Worker
**Database:** Neon Postgres via Prisma

---

## What Lives Here

This service replaces the entire `web/convex/` backend. It must reach **full
functional parity** with all 106 exported Convex functions before the frontend
is cut over in Phase 10.

```
api/
├── src/
│   ├── core/              Layer 1 — global singletons (Prisma, Config, Logger)
│   ├── shared/            Layer 2 — stateless guards, decorators, filters, pipes
│   ├── modules/           Layer 3 — domain modules (one per Convex module)
│   │   ├── auth/
│   │   ├── users/
│   │   ├── articles/
│   │   ├── categories/
│   │   ├── pillars/
│   │   ├── quotes/
│   │   ├── engagement/
│   │   ├── analytics/
│   │   ├── stats/
│   │   ├── ai/
│   │   ├── emails/
│   │   ├── otp/
│   │   ├── search/
│   │   ├── settings/
│   │   └── admin/
│   ├── realtime/          SSE bus — replaces Convex reactive subscriptions
│   ├── worker/            @nestjs/schedule — replaces the 6 Convex crons
│   ├── infrastructure/    Layer 4 — Cloudinary, Nodemailer, Pexels, OpenAI
│   ├── app.module.ts
│   └── main.ts
├── prisma/
│   ├── schema.prisma      20 models, authored in Phase 01
│   └── migrations/
├── openapi.yaml           generated — source of truth for the API contract
├── Dockerfile
├── .env.example
└── package.json
```

## Source of Truth

Do not infer the API surface from guesswork. The parity contract is:

- `docs/convex-ownership.md` — every Convex function → its Nest endpoint
- `docs/migration-inventory.md` — parity checklist, audited in Phase 13
- `docs/phases/phase-XX/backend-task.md` — the current phase's assignments

## Environment

See `api/.env.example` (created in Phase 04). Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL (`-pooler` host) — runtime queries |
| `DIRECT_URL` | Neon **direct** URL — `prisma migrate deploy` only |
| `AUTH_SECRET` | JWT signing, must match the web tier |
| `CORS_ORIGIN` | The web origin, e.g. `https://www.thetruthpill.org` |
| `INTERNAL_JOB_SECRET` | Authenticates Render Cron / worker self-calls |

## Hard Rules

1. **Never run `prisma migrate dev` against the Neon production branch.** It
   prompts to reset and will wipe migrated data. Use `migrate deploy`.
2. **Every mutation that touches a counter runs inside `$transaction`.** Convex
   mutations were serializable by default; Prisma gives no such guarantee.
3. **No client-supplied identity.** The current Convex code authorizes on a
   `userEmail` / `adminEmail` argument the caller controls. Every authenticated
   route must derive identity from a verified token. See
   `docs/phases/phase-03/`.
4. **Swagger decorators are mandatory** on every route and DTO property, or the
   frontend type generation in Phase 10 breaks.
