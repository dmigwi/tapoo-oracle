FROM node:24-bookworm-slim

RUN corepack enable

ENV OBSERVABLE_TELEMETRY_DISABLE=true

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# The version package.json names, installed from package.json rather than repeated here. A version written
# into this file is a second place to change when the repo moves, and the two had already drifted - the
# image prepared 11.25.0 while packageManager asked for 12.4.1, so the prepared copy went unused and every
# pnpm command fetched the other one. `corepack install` reads the field, so there is one version and this
# layer caches on the same file that decides it.
RUN corepack install

RUN pnpm install \
    --frozen-lockfile \
    --config.confirmModulesPurge=false

COPY . .

RUN pnpm build

CMD ["pnpm", "serve"]