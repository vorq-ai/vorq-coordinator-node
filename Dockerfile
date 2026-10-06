# The coordinator's production image, and the one the e2e stack builds too — one
# image definition, so what CI exercises is what ships.
#
# `node:22-slim` in both stages: `engines.node` is `>=22`, and `sodium-native`
# publishes glibc prebuilds that install on this base without a compiler in the
# image. Alpine's musl has no such prebuild and would drag a toolchain in.
FROM node:22-slim AS builder
WORKDIR /app

# The manifests alone, ahead of the sources, so the dependency layer is reused
# across every build that only moved TypeScript. Full `npm ci` here — `tsc` and
# `@types/node` are devDependencies and there is nothing to compile without them.
COPY package.json package-lock.json ./
RUN npm ci

# Railway persists a build cache per service, but says a layer-cache hit is never
# guaranteed — so the install below is the one that has to be quick when the
# layers miss. Mounting npm's own cache makes it a local copy instead of a
# refetch. Swap it for the `RUN npm ci` above to turn it on; the id has to name
# the service (Cmd/Ctrl-K in the dashboard, "Copy ID"), and a wrong one silently
# gets a cache that is always cold.
# RUN --mount=type=cache,id=s/<service-id>-/root/.npm,target=/root/.npm npm ci

# Both tsconfigs: `tsconfig.build.json` carries `outDir`/`rootDir` and extends
# `tsconfig.json`, where `target`, `module` and `strict` actually live. The
# migrations land beside the JS because `migrate()` reads `dist/db/migrations/`
# at boot and `tsc` emits nothing that is not TypeScript.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN node_modules/.bin/tsc -p tsconfig.build.json && cp -r src/db/migrations dist/db/migrations

# The dev dependencies have done their work by here, and the tree that survives
# is what the runtime stage takes verbatim. Pruning rather than installing a
# second time is what keeps the whole image to one dependency resolution; the
# stages share a base and a platform, so `sodium-native`'s prebuild — selected
# when it was installed above — is the right one on the other side of the copy.
RUN npm prune --omit=dev

# --------------------------------------------------------------------------- #

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# `"type": "module"` lives here, and node reads it to decide that the `.js` under
# `dist/` is ESM rather than CommonJS. An image without this file starts and
# fails on the entry point's first `import`.
COPY package.json ./

# The pruned tree, arriving as one layer. A stage boundary is what makes that
# worth doing: files deleted by a later instruction still occupy the layer that
# introduced them, so a build that pruned in place would carry the dev
# dependencies' bytes no matter what the final filesystem looked like.
COPY --from=builder /app/node_modules ./node_modules

# Compiled output only. `src/db/migrations/` rides along inside it — the builder
# stage copies it to `dist/db/migrations/`, and `migrate()` reads it at boot, so
# an image without it starts and then fails on its first connection.
COPY --from=builder /app/dist ./dist

USER node

# `PORT`'s fallback in src/config.ts.
EXPOSE 8402

# `/readyz`, not `/healthz`: the node listens first and cold starts second (see
# the header of src/main.ts), so a socket that answers proves nothing about the
# book. That same design is why the window below is generous — the replay starts
# at the address book's `deployBlock` and a long one takes minutes, all
# of it spent answering 503 by design. `start-period` covers the ordinary case
# and the retries cover a long replay; only a node that never finishes one goes
# unhealthy. The slim image ships no curl and no wget, hence node's global fetch.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=30 \
  CMD ["node","-e","fetch('http://localhost:'+(process.env.PORT||8402)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The compiled entry point, and deliberately not `npm start` — that is
# `tsx src/main.ts`, which is a dev loop and needs sources this image does not
# carry. Running `node` directly also keeps npm out of the runtime entirely, so
# no lifecycle hook can fire here: `scripts/` is absent, and a `prestart` added
# upstream would otherwise kill this container at boot with MODULE_NOT_FOUND.
#
# No tini and no `--init`: `node` is PID 1 on purpose. src/main.ts installs its
# own SIGINT/SIGTERM handlers that close the server, the indexer and the pool, so
# an init shim would only stand between the orchestrator's signal and that code.
#
# `--import` preloads Sentry ahead of the entry point's import graph; see
# src/instrument.ts.
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
