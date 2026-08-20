FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --node-linker=hoisted

FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm prisma generate && pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --node-linker=hoisted
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm prisma generate

FROM prod-deps AS migrate-deps
COPY scripts/prune-runtime-deps.mjs ./scripts/
RUN node scripts/prune-runtime-deps.mjs . prisma

FROM node:22-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=migrate-deps /app/node_modules ./node_modules
COPY --from=migrate-deps /app/prisma ./prisma
COPY --from=migrate-deps /app/prisma.config.ts ./
COPY package.json ./
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM prod-deps AS runtime-deps
COPY scripts/prune-runtime-deps.mjs ./scripts/
# The generated client carries its own postgres query compiler; @prisma/client's
# vendored per-engine copies (70MB) are only read by bundler/edge builds.
RUN node scripts/prune-runtime-deps.mjs . \
 && rm -rf node_modules/@prisma/client/runtime/*wasm-base64* \
           node_modules/@prisma/client/runtime/*.map

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "dist/main.js"]
