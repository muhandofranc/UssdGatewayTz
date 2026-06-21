# UssdGatewayTz Dashboard — Next.js 15 standalone build.
#
# Two-stage: builder installs all deps + runs `next build`; runtime
# carries only the standalone server + static assets + production
# node_modules pulled in by the standalone trace.

# ---------- 1. builder -------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# APK_REFRESH is a cache-buster — pass any unique value (build_id /
# date) at build time so the apk update+upgrade layer doesn't get
# served from the buildx cache, forcing it to pick up any new alpine
# security patches published after the cached layer was built. Same
# pattern as APT_REFRESH in the gateway Dockerfile. Without this,
# alpine fixes (e.g. CVE-2026-45447 openssl heap UAF, fixed at
# libcrypto3 3.5.7-r0) silently get skipped on rebuild.
ARG APK_REFRESH=build
RUN echo "apk-refresh=${APK_REFRESH}" > /etc/apk-refresh \
 && apk update \
 && apk upgrade --no-cache

# Copy manifest first so this layer only re-runs when deps change.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Source + Next config + tailwind/postcss + static assets + worker.
COPY tsconfig.json next.config.mjs tailwind.config.ts postcss.config.mjs ./
COPY src ./src
COPY public ./public
COPY worker ./worker

# next.config has `output: "standalone"` so this produces
# .next/standalone/ + .next/static/.
RUN npm run build

# ---------- 2. runtime -------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Cache-bust the runtime apk-upgrade too — the builder's upgrade only
# patches the builder layer; the runtime layer is what actually ships
# and runs, so it needs its own patched alpine. Re-using the same ARG
# value across stages is fine; buildx still treats each FROM's layer
# cache separately.
ARG APK_REFRESH=build
RUN echo "apk-refresh=${APK_REFRESH}" > /etc/apk-refresh \
 && apk update \
 && apk upgrade --no-cache

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root user — Next docs' standard pattern. .next/standalone is
# self-contained so we don't need a separate node_modules copy.
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Pre-create the exports volume mount point in the IMAGE so that on
# first volume creation Docker copies the dir's ownership/perms to
# the named volume. Without this, the volume starts root-owned and
# the non-root worker hits EACCES. NOTE: this only fixes the volume
# on FIRST creation — existing volumes need `docker compose down -v`
# (or a manual chown) to pick up the new perms.
RUN mkdir -p /exports && chown nextjs:nodejs /exports

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next standalone output does NOT include /public; copy it ourselves
# so /logo.svg and other static assets resolve at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Background worker script (ussd-exports-worker container runs this
# via `node worker/exports_worker.mjs`). pg is already in the
# standalone trace because the dashboard's lib/db.ts uses it.
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
