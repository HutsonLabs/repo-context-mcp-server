# repo-context-mcp-server

MCP server that gives AI coding assistants deep codebase context through four complementary systems:

1. **Vector search** — Semantic similarity search over code, docs, and memory
2. **Dependency graph** — Import edges, type/symbol consumers, and git co-change analysis
3. **LLM Wiki** — AI-maintained knowledge base for decisions and tribal knowledge
4. **Partition scheduler** — Computes which issues can be worked in parallel without file conflicts

Vectors are stored in **Postgres + pgvector**, static analysis uses the TypeScript AST, and co-change data is mined from git history. The server speaks the **Streamable HTTP** MCP transport and is **multi-repo**: a single database/instance can serve many repositories, each isolated by a `repo_id`. It ships as a Docker Compose stack (server + database) and bootstraps automatically when pointed at a repo.

> **Architecture note (v26.06.1).** Earlier versions embedded LanceDB and spoke the stdio transport. The server now runs as a long-lived HTTP service backed by Postgres+pgvector. See [How it works](#how-it-works) for details.

## Tools

### Search (vector-based)

- **search_code** — Search source code for implementations, patterns, and files. Returns relevant chunks with file paths and exports.
- **search_docs** — Search project documentation for architecture, standards, and guidelines.
- **search_memory** — Search past decisions, feedback, and project context from Claude Code memory.

### Dependency graph (structural)

- **query_dependencies** — Find what a file imports and what imports it, with configurable traversal depth.
- **query_co_changes** — Find files that frequently change together in git history.
- **query_type_consumers** — Find where a type/interface is defined and which files consume it. Supports qualified `defFile::name` lookups for disambiguation.

### Wiki (knowledge base)

- **search_wiki** — Semantic search across wiki pages.
- **read_wiki_page** — Read a specific wiki page by name.
- **write_wiki_page** — Create or update a wiki page.
- **list_wiki_pages** — List all wiki pages with summaries.

### Scheduling

- **partition** — Given per-issue "touch sets" (the files each issue plans to modify), compute a conflict graph and a deterministic wave schedule of which issues can run in parallel. See [Partition scheduler](#partition-scheduler).

## Quick start (Docker Compose)

The recommended way to run the server is the bundled Compose stack, which starts Postgres (with the pgvector extension) and the MCP server together.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2
- An embedding provider reachable from the container. The default `config.docker.json` targets **host [Ollama](https://ollama.com)**, so it runs GPU-free:

  ```sh
  # macOS
  brew install ollama
  ollama serve                     # runs on http://localhost:11434
  ollama pull nomic-embed-text     # 768-dim embeddings
  ```

  The container reaches host Ollama via `host.docker.internal` (configured in `docker-compose.yml`).

### Run

```sh
# Index the current directory (defaults to "." — override with INDEX_REPO)
INDEX_REPO=/path/to/your/project docker compose up --build
```

This brings up:

| Service | Purpose | Host port |
|---|---|---|
| `db` | Postgres 17 + pgvector | `5433` (debugging only) |
| `mcp` | MCP server (Streamable HTTP) | `3333` → `POST /mcp` |

The server starts serving immediately and builds the index in the background. Check readiness:

```sh
curl localhost:3333/health
# {"status":"ok","index":"building"}  -> later: {"status":"ok","index":"ready"}
```

The indexed repo is bind-mounted at `/workspace` (read-write, so `.repo-context/` and the wiki can be written back).

## Connect Claude Code

Point Claude Code at the HTTP endpoint:

```sh
claude mcp add --transport http repo-context http://localhost:3333/mcp
```

Then restart Claude Code. The tools above become available as `repo-context` MCP tools. Searches return empty until `/health` reports `"index":"ready"`.

### Selecting a repo (`X-Repo-Id`)

One server can serve many repositories. A client says which repo a request
targets with the **`X-Repo-Id`** header, set per project in `.mcp.json` (or in
your user settings). The repo named must exist in the server's `repos` config
(see [Multiple repositories](#multiple-repositories)).

```jsonc
// .mcp.json — same server, the header picks the repo
{
  "mcpServers": {
    "repo-context": {
      "type": "http",
      "url": "http://localhost:3333/mcp",
      "headers": { "X-Repo-Id": "pegasus" }
    }
  }
}
```

With a single configured repo, the header is optional (that repo is the
default). With several, it is required — a request without it gets `400` listing
the available repos, and an unknown id gets `404`. A `/mcp/<repoId>` path
segment is also accepted as a fallback (handy for `curl`), but the header is the
intended contract.

## Run locally without Docker

The server requires a reachable Postgres with the `pgvector` extension. With one available, run it directly with [Bun](https://bun.sh):

```sh
curl -fsSL https://bun.sh/install | bash   # install Bun
bun install

DATABASE_URL="postgres://postgres:postgres@localhost:5432/repo_context" \
REPO_ID="my-project" \
PROJECT_ROOT="/path/to/your/project" \
PORT=3000 \
bun run src/index.ts
```

A throwaway pgvector database for local development:

```sh
docker run -d --name repo-context-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=repo_context \
  pgvector/pgvector:pg17
```

## Configuration

### Environment variables

Container/runtime settings (override the defaults shown):

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/repo_context` | Postgres connection string (needs the `vector` extension; the server runs `CREATE EXTENSION IF NOT EXISTS vector`). |
| `REPO_ID` | `default` | **Single-repo fallback only.** Logical id for the lone repo synthesized when the config has no `repos` array. Ignored when `repos` is set (each entry carries its own `repoId`). Clients select a repo at request time via the `X-Repo-Id` header. |
| `PROJECT_ROOT` | `process.cwd()` | **Single-repo fallback only.** Absolute path to the lone repo to index (Docker: `/workspace`). Ignored when `repos` is set. |
| `PORT` | `3000` | HTTP port the server listens on (`POST /mcp`, `GET /health`). |

> Multi-repo selection is **per request** (`X-Repo-Id` header), not per env var.
> `REPO_ID`/`PROJECT_ROOT` only configure the single-repo fallback. See
> [Multiple repositories](#multiple-repositories).

### Config file

Indexing behavior is controlled by a JSON config. Resolution order (first found wins):

1. `<cwd>/repo-context.json`
2. `<cwd>/.repo-context/config.json`
3. `<server-dir>/config.json` (the Docker image copies `config.docker.json` here)

All fields except `embedding` are optional:

```json
{
  "embedding": {
    "type": "ollama",
    "apiKey": null,
    "baseUrl": "http://localhost:11434",
    "model": "nomic-embed-text"
  },
  "codePatterns": ["**/*.{ts,tsx,js,jsx}"],
  "docPatterns": ["docs/*.md", "CLAUDE.md", "README.md", ".claude/rules/*.md"],
  "skipPatterns": [
    "node_modules", ".next", "/dist/", "/build/",
    ".bundle.", ".min.", "__tests__", "__mocks__",
    ".claude/worktrees", ".repo-context"
  ],
  "graph": {
    "coChangeMinCount": 3,
    "coChangeMaxCommits": 500
  },
  "wiki": {
    "autoInit": true
  }
}
```

| Field | Default | Description |
|---|---|---|
| `embedding` | (required) | Embedding provider configuration |
| `codePatterns` | `["**/*.{ts,tsx,js,jsx}"]` | Glob patterns for source code files |
| `docPatterns` | `["docs/*.md", "CLAUDE.md", ".claude/rules/*.md"]` | Glob patterns for documentation files |
| `skipPatterns` | node_modules, .next, dist, build, tests, mocks | Substrings in file paths to skip |
| `projectRoot` | `PROJECT_ROOT` env / `process.cwd()` | Override project root (single-repo fallback) |
| `memoryDir` | auto-detected | Override Claude Code memory directory |
| `repos` | (unset) | Array of repositories to serve. When present, the server runs multi-repo and ignores `projectRoot`/`REPO_ID`. See [Multiple repositories](#multiple-repositories). |
| `graph.coChangeMinCount` | `3` | Minimum co-occurrence count to record a co-change pair |
| `graph.coChangeMaxCommits` | `500` | How many commits to scan for co-change analysis |
| `wiki.autoInit` | `true` | Create wiki directory and index/log files on first run |

> The embedding **dimension is derived from the model** (e.g. `nomic-embed-text` → 768, `nomic-embed-code` → 3584) and fixes the `vector(N)` column width at first run. Changing models against an existing database requires a fresh `repo_id` or a reset of the `chunks` table.

### Multiple repositories

One server instance can index and serve many repositories, isolated by
`repo_id` in the shared `chunks` table. Add a `repos` array to the config — each
entry is a `repoId` plus the `projectRoot` to index, and may override any of the
per-repo fields (`memoryDir`, `codePatterns`, `docPatterns`, `skipPatterns`,
`graph`, `wiki`); anything omitted inherits the server-level value.

```json
{
  "embedding": { "type": "ollama", "apiKey": null, "baseUrl": "http://host.docker.internal:11434", "model": "nomic-embed-text" },
  "repos": [
    { "repoId": "pegasus", "projectRoot": "/repos/pegasus" },
    { "repoId": "iceberg", "projectRoot": "/repos/iceberg" }
  ]
}
```

A ready-to-edit copy lives at `config.multi-repo.example.json`. Clients then
select a repo per request via the [`X-Repo-Id`](#selecting-a-repo-x-repo-id)
header, and `GET /health` reports each repo's index state:

```json
{ "status": "ok", "index": "ready", "repos": { "pegasus": "ready", "iceberg": "building" } }
```

In Docker, mount each repo where its `projectRoot` points and supply the config
without rebuilding the image (it is bind-mounted to `/app/config.json`):

```sh
REPO_CONFIG=./config.multi-repo.example.json REPOS_DIR=/abs/parent/of/repos \
  docker compose up --build   # after uncommenting the /repos mount in docker-compose.yml
```

> **One embedding model per server.** All repos share a single `chunks` table
> and therefore a single `vector(N)` width, so every repo must use the same
> server-level `embedding` model. Per-repo models would need separate tables and
> are not supported.

## Embedding providers

| Provider | Model (example) | Dimensions | Config `type` |
|---|---|---|---|
| Ollama | nomic-embed-text | 768 | `ollama` |
| TEI (HF Text Embeddings Inference) | nomic-embed-code | 3584 | `tei` |
| OpenAI | text-embedding-3-small | 1536 | `openai` |
| Google | text-embedding-004 | 768 | `google` |
| Mistral | mistral-embed | 1024 | `mistral` |
| LM Studio | (custom) | 768 | `lmstudio` |

The production target is **`nomic-embed-code` served via TEI** (GPU); the Compose default uses host Ollama with `nomic-embed-text` so it works without a GPU. Nomic models use **asymmetric task prefixes** — queries and documents are embedded with different instructions — which the adapter applies automatically.

## Usage with Claude Code

To ensure Claude always uses repo-context as its first tool when exploring your codebase, add the following to your project's `CLAUDE.md`:

```markdown
## Context Retrieval

Always use the repo-context MCP tools **first** when exploring the codebase — before Glob, Grep, or Read.

- `search_code` — find implementations, patterns, files
- `search_docs` — find architecture, standards, guidelines
- `search_memory` — find past decisions, feedback, project context
- `query_dependencies` — find what imports a file and what it imports
- `query_co_changes` — find files that change together
- `query_type_consumers` — find all consumers of a type before changing it
- `search_wiki` / `read_wiki_page` — find architectural decisions and tribal knowledge
```

## How it works

### Vector search

- **Code indexing** — TypeScript AST-aware chunking splits at top-level declarations (functions, classes, interfaces, types). Falls back to a sliding window for other file types.
- **Doc indexing** — Splits markdown on `##` heading boundaries.
- **Memory indexing** — Indexes Claude Code memory files with YAML frontmatter parsing.
- **Wiki indexing** — Same heading-based splitting as docs.
- **Deduplication** — Content hashing (SHA-256) avoids re-embedding unchanged files; only files whose hash changed are re-embedded.
- **Pruning** — On every re-index (and on watcher `unlink`), rows for files no longer present on disk are removed, so deletions made while the server was down are cleaned up.
- **File watching** — Chokidar watches for changes with a debounce and re-indexes automatically.
- **Vector storage** — All chunks live in a single Postgres `chunks` table with a `vector(N)` column (pgvector), an **HNSW cosine index** for similarity search, and a `(repo_id, source, file_path)` lookup index. Rows are keyed by `(repo_id, source, id)`; writes are transactional delete-then-insert upserts.

### Multi-repo isolation

Every row carries a `repo_id`. One database **and one server** can serve many repositories simultaneously: each is declared in the `repos` config, indexed and watched independently, and a request selects which one via the `X-Repo-Id` header. Searches, indexing, and pruning are always scoped to that repo's `repo_id`, so repos never see each other's rows.

### Transport

The server is a long-lived process exposing **Streamable HTTP** at `POST /mcp`. Each MCP session gets its own transport and `McpServer` instance, bound at initialization to the repo resolved from the `X-Repo-Id` header (or `/mcp/<repoId>` path fallback), and thereafter routed by the `mcp-session-id` header. `GET /health` reports liveness and per-repo index state (`starting` → `building` → `ready`). The server begins accepting connections before the initial index completes.

### Dependency graph

Built by static analysis and git history, stored as `.repo-context/graph.json`. No embeddings required — queries are direct lookups.

- **Import edges** — TypeScript AST parses every file to extract `import` statements; relative imports resolve to actual file paths. Named imports are tracked per edge.
- **Type & symbol consumers** — Reverse index from a type name (and from a qualified `defFile::name`) to every file that imports it. Use this before modifying a type to find all downstream consumers.
- **Co-change pairs** — Mines `git log` for files that change together, filtering merge commits and large refactors.
- **HEAD SHA** — The graph records the git HEAD it was built against, so partitions can be stamped/validated.
- **Auto-rebuild** — The graph rebuilds automatically when code files change (via the file watcher).

### Partition scheduler

`partition` answers: *given a batch of issues and the files each will touch, which can be worked at the same time?*

- **File-level gate** — Two issues conflict **iff their file sets intersect**. This is the only thing that gates parallelization.
- **Waves** — A deterministic wave schedule is computed via greedy graph coloring. `Wave 1` (the independent set) is the group of issues that can be worked simultaneously; later waves depend on earlier ones clearing.
- **Hidden-coupling warnings** — If two issues touch files that *historically co-change* (above a threshold), that surfaces as an **advisory warning only** — it never adds a conflict edge or changes the waves.
- **Deterministic** — Same inputs always produce the same conflict graph, waves, and warnings (issues and shared files are ordered before processing).

### LLM Wiki

A structured, cross-linked knowledge base maintained by the AI assistant. Stored in `.repo-context/wiki/` as markdown files.

**What belongs in the wiki:**
- Architectural decisions and their rationale
- Known pitfalls and failure modes
- Why certain files are coupled (not just that they are)
- Patterns that were tried and abandoned
- Context that can't be derived from code or git history alone

**What does NOT belong in the wiki:**
- Code patterns (readable from the code itself)
- File structure (derivable from the filesystem)
- Git history (available via `git log`)

**Page format:**
```markdown
# Page Title

**Summary**: One-line description of this page.

**Last updated**: 2024-01-15

---

Content with [[wiki-links]] to connect related pages.

## Related pages

- [[related-concept]]
```

## Architecture

```
src/
  index.ts        Entry point, MCP tool registration, HTTP server, startup
  types.ts        Shared TypeScript interfaces
  db.ts           Postgres + pgvector connection, indexing, vector search
  embeddings.ts   Embedding provider adapter (Ollama, TEI, OpenAI, ...)
  chunker.ts      AST-aware code chunking, markdown splitting
  graph.ts        Dependency graph extraction and co-change mining
  partition.ts    File-level conflict gate and parallel-wave scheduler
  wiki.ts         Wiki CRUD operations and page management
  watcher.ts      File watcher with debounced re-indexing

Dockerfile          Bun runtime image for the server
docker-compose.yml  Server + pgvector database
config.docker.json  Container config (host Ollama embeddings)
```

### Data flow

```
Startup
  1. Load config (config file) + read env (DATABASE_URL, REPO_ID, PROJECT_ROOT, PORT)
  2. initDb: connect Postgres, CREATE EXTENSION vector, create `chunks` table + indexes
  3. Initialize wiki directory
  4. Start HTTP server (Streamable HTTP, POST /mcp) — serving begins immediately
  5. Build index in background (state: building -> ready):
     a. Code files   -> AST chunking     -> embed -> chunks (source='code')
     b. Doc files    -> heading split     -> embed -> chunks (source='docs')
     c. Memory files -> frontmatter parse -> embed -> chunks (source='memory')
     d. Wiki files   -> heading split     -> embed -> chunks (source='wiki')
     e. Code files   -> AST import parse  -> graph.json
     f. Git log      -> co-change mining  -> graph.json
  6. Start file watchers (debounced re-index + prune on changes)

Queries
  - search_* tools -> embed query -> pgvector cosine search (scoped by repo_id) -> results
  - query_* tools  -> load graph.json -> direct lookup -> results
  - partition      -> load graph.json -> conflict graph + waves + advisory warnings
  - wiki CRUD      -> read/write files -> re-index wiki rows
```

## Development

### Tests

```sh
bun test
```

- **`src/partition.test.ts`** — pure unit tests for the conflict gate, wave scheduling, determinism, and advisory co-change overlay. Requires no external services.
- **`src/db.test.ts`** — integration tests for the Postgres schema and the dedup / upsert / prune / search lifecycle. They run a self-contained fake embedder (no Ollama needed) and are **skipped unless `DATABASE_URL` is set**:

  ```sh
  DATABASE_URL="postgres://postgres:postgres@localhost:5432/repo_context" bun test
  ```

  The suite isolates itself under a dedicated `repo_id` and cleans up after each run.

### Type checking

```sh
bunx tsc --noEmit
```
