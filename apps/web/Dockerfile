# Converge web app: static build served by nginx, which also load-balances /api and /ws
# across the API containers (build context: repository root).
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/client/package.json packages/client/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile --filter @converge/web...
COPY packages/client packages/client
COPY apps/web apps/web
RUN pnpm --filter @converge/web exec vite build

FROM nginx:1.27-alpine
COPY infra/web.nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
