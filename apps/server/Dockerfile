# Converge API server (build context: repository root).
#   docker build -f apps/server/Dockerfile -t converge-api .
FROM node:24-slim
WORKDIR /repo
RUN corepack enable pnpm

# Dependencies first (cached unless manifests change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --filter @converge/server...

COPY packages/client packages/client
COPY apps/server apps/server
WORKDIR /repo/apps/server
# prisma.config.ts requires these to be set; generation never connects to them.
RUN DATABASE_URL=mysql://build:build@localhost:3306/build SHADOW_DATABASE_URL=mysql://build:build@localhost:3306/build     pnpm db:generate && pnpm build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
# Migrations are a separate one-shot command: `pnpm exec prisma migrate deploy`.
CMD ["node", "dist/server.js"]
