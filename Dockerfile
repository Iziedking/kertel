# Kertel on a server.
#
# Two stages so the shipped image has no compiler and no dev dependencies. The
# runtime stage installs production dependencies only, which also means the
# native-build question never arises: Kertel's storage is node:sqlite, built
# into Node itself.
#
# Pinned to a Node 22 minor rather than `22` or `lts`, because node:sqlite is
# still marked experimental and a silent minor bump is not something to
# discover on a machine holding live positions.

FROM node:22.17-bookworm-slim AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/x402/package.json packages/x402/
COPY packages/providers/package.json packages/providers/
COPY apps/kertel-plugin/package.json apps/kertel-plugin/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npx tsc --build

FROM node:22.17-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/x402/package.json packages/x402/
COPY packages/providers/package.json packages/providers/
COPY apps/kertel-plugin/package.json apps/kertel-plugin/
RUN npm ci --omit=dev --ignore-scripts

# Compiled output plus the captured 402 challenges, which fixture mode reads.
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/x402/dist packages/x402/dist
COPY --from=build /app/packages/providers/dist packages/providers/dist
COPY --from=build /app/apps/kertel-plugin/dist apps/kertel-plugin/dist
COPY fixtures fixtures

# The database lives here and must be a mounted volume. A database inside the
# image is lost on the next deploy, and losing it loses every armed plan, every
# high-water mark, and the record of what has already been sold.
ENV KERTEL_DATA_DIR=/data
VOLUME ["/data"]

# Not root. The process needs to write one directory and reach three hosts.
RUN useradd --system --uid 10001 --home /app kertel \
    && mkdir -p /data && chown -R kertel:kertel /app /data
USER kertel

# Fails the container when the monitor is not running or the database is
# unreadable, so a supervisor restarts it rather than believing a wedged
# process is healthy.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "const{openStore}=require('/app/apps/kertel-plugin/dist/infra/store.js');" 2>/dev/null \
      || node --input-type=module -e "import('/app/apps/kertel-plugin/dist/infra/store.js').then(m=>{const s=m.openStore(process.env.KERTEL_DATA_DIR+'/kertel.sqlite');s.safetyState();s.close();}).catch(()=>process.exit(1))"

CMD ["node", "apps/kertel-plugin/dist/daemon.js"]
