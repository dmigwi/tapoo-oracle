FROM node:24-bookworm-slim

RUN corepack enable \
    && corepack prepare pnpm@11.25.0 --activate

ENV OBSERVABLE_TELEMETRY_DISABLE=true

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install \
    --frozen-lockfile \
    --config.confirmModulesPurge=false

COPY . .

RUN pnpm build

CMD ["pnpm", "serve"]