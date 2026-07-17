# Multi-stage : build du package n8n, puis copie dans une image n8n.
# Calqué sur n8n-nodes-playwright-core (chaîne interne éprouvée).
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json gulpfile.js index.js ./
COPY nodes ./nodes
COPY credentials ./credentials

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build

RUN mkdir -p /out/n8n-nodes-async-api \
    && cp package.json /out/n8n-nodes-async-api/package.json \
    && cp -R dist /out/n8n-nodes-async-api/dist \
    && cp -R node_modules /out/n8n-nodes-async-api/node_modules

FROM n8nio/n8n:2.17.5

USER root

RUN mkdir -p /opt/custom-nodes/n8n-nodes-async-api
COPY --from=builder /out/n8n-nodes-async-api/ /opt/custom-nodes/n8n-nodes-async-api/
RUN test -d /opt/custom-nodes/n8n-nodes-async-api/node_modules

USER node
WORKDIR /home/node
CMD ["start"]
