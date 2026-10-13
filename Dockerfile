# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# The Truth Pill — API image (Phase 03)
#
# Runtime has TWO stages. The generated Prisma client is committed under
# `src/generated/prisma`, so no `prisma generate` runs here and the build needs
# no database URL. Neon supplies `DATABASE_URL` at runtime (Render).
#
# ⚠️  Build with `docker build -t truth-pill-api ./api` from the repo root, or
#     `docker build -t truth-pill-api .` from `api/`.
# ---------------------------------------------------------------------------

# ---- build stage: compile TypeScript to dist/ ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production dependencies + compiled output ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/main.js"]
