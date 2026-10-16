# syntax=docker/dockerfile:1.7
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.10.1
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ace/dashboard build

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
