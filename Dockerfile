# repo-context MCP server — Bun runtime image
FROM oven/bun:1

# git is needed for the dependency graph's co-change mining
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source
COPY tsconfig.json ./
COPY src ./src
# Container config (embedding endpoint etc.) -> loaded as the server-dir config.json
COPY config.docker.json ./config.json

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
