# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# The platform image: HTTP server + notification worker (spawned as a child
# process by server/index.ts). Provider-neutral — runs on Cloudflare Containers,
# Cloud Run, Fly, Railway or any Docker host. Migrations are NOT run here; the
# deploy pipeline runs `pnpm phase1:db:migrate` once, before rollout.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Prisma's engines need libssl, and outbound TLS from native code needs a CA
# store; the slim image has neither. Skipped on bases that already ship them.
RUN corepack enable \
 && if ! ldconfig -p | grep -q 'libssl.so.3' || [ ! -d /etc/ssl/certs ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app

# ── build: full dependencies, compile client + server + worker ───────────────
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── runtime: production dependencies only ────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile \
 && rm -rf /root/.cache
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# /api/health = the process is alive; /api/ready also checks the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
