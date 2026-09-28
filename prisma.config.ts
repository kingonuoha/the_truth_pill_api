// Prisma 7 configuration — ADR-004.
//
// Prisma 7 does NOT read a connection string from the `datasource` block in
// schema.prisma. It reads it from here. `prisma/schema.prisma` declares
// `provider = "postgresql"` and no `url`, which is correct and required —
// native types such as `@db.Uuid` and `@db.Timestamptz(3)` are rejected if the
// datasource block is incomplete.
//
// TWO URLS, AND THE DIFFERENCE IS LOAD-BEARING (ADR-003):
//
//   DIRECT_URL   direct host, hostname WITHOUT `-pooler`. Used by every
//                schema-reading CLI command and by `migrate deploy`.
//                The pooler cannot run DDL.
//
//   DATABASE_URL pooled host, hostname WITH `-pooler`. Runtime queries only,
//                via `@prisma/adapter-neon`. Never used for DDL.
//
// ⚠️  NEVER run `prisma migrate dev` against Neon. It prompts to reset and will
//     wipe migrated data. Use `prisma migrate deploy`. (AGENTS.md rule 5)

import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Instantiated eagerly so `migrate diff` and `validate` work with a schema
  // only — no database is contacted by either.
  datasource: {
    // Throws at config load if DIRECT_URL is unset. That is deliberate: a
    // silent empty string here produces a confusing authentication error much
    // later, from inside the driver.
    url: env("DIRECT_URL"),
  },
});
