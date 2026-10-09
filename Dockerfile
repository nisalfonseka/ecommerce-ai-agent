# syntax=docker/dockerfile:1.7
# Engine image: build the bundle in the monorepo, then ship only dist/, production npm packages,
# the migrations and the price table. Workspace packages (@ace/*) are bundled into dist/.

FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.10.1
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ace/engine build \
 && pnpm --filter @ace/engine deploy --prod /out \
 && cp -r packages/db/migrations /out/migrations

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json /out/model-prices.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/main.js"]
