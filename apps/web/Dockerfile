# syntax=docker/dockerfile:1
# Build the lucid-rag web app into a self-contained Next.js standalone server.
# Build context is the monorepo root (the app needs the workspace packages).

# ── Build stage ──
FROM node:20-slim AS builder
WORKDIR /repo
COPY . .
RUN npm ci && npm run build -w @lucid-rag/web

# ── Runtime stage ──
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle carries the server + traced node_modules + package.json.
COPY --from=builder /repo/apps/web/.next/standalone ./
# Static assets aren't part of the traced server bundle.
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
