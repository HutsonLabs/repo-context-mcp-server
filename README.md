# repo-context-mcp-server

MCP server that gives AI coding assistants deep codebase context through four complementary systems:

1. **Vector search** — Semantic similarity search over code, docs, and memory
2. **Dependency graph** — File import edges, **symbol-level structural edges** (class/function `calls` / `extends` / `implements` / `uses-type`, resolved by the TypeScript type checker), an **advisory embedding-similarity overlay** between symbols, type/symbol consumers, and git co-change analysis
3. **LLM Wiki** — AI-maintained knowledge base for decisions and tribal knowledge
4. **Partition scheduler** — Computes which issues can be worked in parallel without file conflicts

Vectors are stored in a single local **sqlite** file via the **[sqlite-vec](https://github.com/asg017/sqlite-vec)** extension, static analysis uses the TypeScript AST, and co-change data is mined from git history. The server runs as a **local stdio MCP server** — one process per repository, spoken over stdin/stdout — with **no docker, no Postgres, and no network listener**. Everything (chunk embeddings + the dependency graph) lives in `.repo-context/index.db` inside the indexed repo. Embeddings are produced by a host embedder (Ollama by default).

> **Architecture note (v26.06.2).** The server is local-only again: stdio transport + an embedded sqlite/sqlite-vec store, replacing the prior HTTP-over-Postgres+pgvector deployment. (An even earlier version used LanceDB; sqlite-vec now fills that role and also holds the graph.) See [How it works](#how-it-works) for details.

> **New here?** Read the [docs](./docs/) — a [getting-started guide](./docs/getting-started.md) (install, connect, and a tool-by-tool playbook) and [why semantic-driven context](./docs/why-semantic-driven-context.md) (why pairing meaning-first retrieval with a verified structural graph makes coding agents more reliable). This README is the reference; the docs are the guide.

## Tools

### Search (vector-based)

- **search_code** — Search source code for implementations, patterns, and files. Returns relevant chunks with file paths and exports.
- **search_docs** — Search project documentation for architecture, standards, and guidelines.
- **search_memory** — Search past decisions, feedback, and project context from Claude Code memory.

### Dependency graph (structural)

- **query_dependencies** — Find what a file imports and what imports it, with configurable traversal depth.
- **query_co_changes** — Find files that frequently change together in git history.
- **query_type_consumers** — Find where a type/interface is defined and which files consume it. Supports qualified `defFile::name` lookups for disambiguation.
- **query_symbol** — Look up a class/function/type at **declaration granularity** (by `file::name` id or bare name). Returns its definition, **exact** structural edges in both directions (what it `calls`/`extends`/`implements`/uses, and what calls/uses it — resolved by the type checker), and **advisory** semantic neighbors (embedding similarity, never authoritative).

### Wiki (knowledge base)

- **search_wiki** — Semantic search across wiki pages.
- **read_wiki_page** — Read a specific wiki page by name.
- **write_wiki_page** — Create or update a wiki page.
- **list_wiki_pages** — List all wiki pages with summaries.

### Scheduling

- **partition** — Given per-issue "touch sets" (the files each issue plans to modify), compute a conflict graph and a deterministic wave schedule of which issues can run in parallel. See [Partition scheduler](#partition-scheduler).

## Quick start

The server runs locally with [Bun](https://bun.sh) and speaks the stdio MCP
transport — Claude Code (or any MCP client) launches it as a child process.

### Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- An **extension-capable sqlite**. macOS ships a libsqlite3 with extension
  loading compiled out, so install one Bun can load `sqlite-vec` into:

  ```sh
  brew install sqlite        # macOS — used automatically via Database.setCustomSQLite()
  ```

  Auto-detected at `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` (Apple
  Silicon) or `/usr/local/...` (Intel). Override with `REPO_CONTEXT_SQLITE`.
  On Linux the bundled sqlite usually loads extensions and no install is needed.
- A host **embedder**. The default config targets [Ollama](https://ollama.com):

  ```sh
  brew install ollama
  ollama serve                     # http://localhost:11434
  ollama pull nomic-embed-text     # 768-dim embeddings
  ```

### Run

```sh
bun install
cd /path/to/your/project          # the repo to index (holds repo-context.json)
bun run /path/to/repo-context-mcp-server/src/index.ts
```

The process speaks JSON-RPC on stdin/stdout (logs go to stderr). It answers the
`initialize` handshake immediately and builds the index in the background;
searches return empty until that first build finishes. The store is written to
`<project>/.repo-context/index.db`.

## Connect Claude Code

Add a stdio server entry to the project's `.mcp.json`:

```jsonc
// <project>/.mcp.json
{
  "mcpServers": {
    "repo-context": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/repo-context-mcp-server/src/index.ts"]
    }
  }
}
```

Claude Code launches the server with the project directory as its working
directory, so config resolution (`<cwd>/repo-context.json`) and the default
project root both point at the repo being worked on. Restart Claude Code and the
tools above become available as `repo-context` MCP tools.

> **One process per repo.** A stdio server serves a single repository. To index
> several, run one server per project (each project's `.mcp.json` launches its
> own). The `repos` config array is still honored; with more than one entry, set
> the `REPO_ID` env var to pick which one this process serves (the first entry
> otherwise).

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `REPO_ID` | `default` | Logical id isolating this repo's rows in the sqlite store. With a multi-entry `repos` config, selects which configured repo this process serves. |
| `PROJECT_ROOT` | `process.cwd()` | Absolute path to the repo to index. Defaults to the launch directory. Ignored when `repos` is set. |
| `REPO_CONTEXT_SQLITE` | auto-detect (Homebrew) | Path to a libsqlite3 that supports `loadExtension`, used to load `sqlite-vec`. Only needed if auto-detection misses. |

### Config file

Indexing behavior is controlled by a JSON config. Resolution order (first found wins):

1. `<cwd>/repo-context.json`
2. `<cwd>/.repo-context/config.json`
3. `<server-dir>/config.json`

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
    "coChangeMaxCommits": 500,
    "symbols": { "enabled": true },
    "semantic": { "minScore": 0.78, "topK": 5 }
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
| `graph.symbols.enabled` | `true` | Build the symbol-level structural graph (class/function nodes + resolved edges) |
| `graph.semantic.minScore` | `0.78` | Minimum cosine similarity to record an advisory semantic-overlay edge |
| `graph.semantic.topK` | `5` | Max semantic neighbors kept per symbol |
| `wiki.autoInit` | `true` | Create wiki directory and index/log files on first run |

> The embedding **dimension is derived from the model** (e.g. `nomic-embed-text` → 768, `nomic-embed-code` → 3584) and fixes the `vector(N)` column width at first run. Changing models against an existing database requires a fresh `repo_id` or a reset of the `chunks` table.

### Multiple repositories

A stdio server serves **one repository per process**, but the config may still
declare several so the same file can drive multiple per-project launches. Add a
`repos` array — each entry is a `repoId` plus the `projectRoot` to index, and may
override any per-repo field (`memoryDir`, `codePatterns`, `docPatterns`,
`skipPatterns`, `graph`, `wiki`); anything omitted inherits the server-level
value.

```json
{
  "embedding": { "type": "ollama", "apiKey": null, "baseUrl": "http://localhost:11434", "model": "nomic-embed-text" },
  "repos": [
    { "repoId": "pegasus", "projectRoot": "/Users/me/repos/pegasus" },
    { "repoId": "iceberg", "projectRoot": "/Users/me/repos/iceberg" }
  ]
}
```

A ready-to-edit copy lives at `config.multi-repo.example.json`. With more than
one entry, set `REPO_ID` to choose which repo this process serves (the first
entry otherwise). To work several repos at once, launch one server per project —
typically via each project's own `.mcp.json`. Each repo's rows stay isolated by
`repo_id`, and each writes to its own `<projectRoot>/.repo-context/index.db`.

> **One embedding model per store.** The embedding dimension is baked into the
> sqlite-vec table, so a given `index.db` is tied to one `embedding` model. The
> store auto-rebuilds if the configured model's dimension changes.

## Embedding providers

| Provider | Model (example) | Dimensions | Config `type` |
|---|---|---|---|
| Ollama | nomic-embed-text | 768 | `ollama` |
| TEI (HF Text Embeddings Inference) | nomic-embed-code | 3584 | `tei` |
| OpenAI | text-embedding-3-small | 1536 | `openai` |
| Google | text-embedding-004 | 768 | `google` |
| Mistral | mistral-embed | 1024 | `mistral` |
| LM Studio | (custom) | 768 | `lmstudio` |

The richest option is **`nomic-embed-code` served via TEI** (GPU); the default config uses host Ollama with `nomic-embed-text` so it works without a GPU. Nomic models use **asymmetric task prefixes** — queries and documents are embedded with different instructions — which the adapter applies automatically.

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
- `query_symbol` — find a symbol's callers/callees and what it extends/uses, before changing it
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
- **Vector storage** — Chunk metadata lives in a relational `chunks` table; embeddings live in a [sqlite-vec](https://github.com/asg017/sqlite-vec) `vec0` virtual table (`distance_metric=cosine`) keyed by the same `rowid`, with `repo_id` and `source` as filterable columns. Search is a KNN `match` pre-filtered by repo + source, joined back to `chunks`. Writes are transactional delete-then-insert upserts. Everything sits in one file: `<projectRoot>/.repo-context/index.db`.

### Transport

The server speaks the **stdio** MCP transport: it reads JSON-RPC from stdin and writes responses to stdout (all logging goes to stderr to keep the protocol stream clean). One process serves a single repo. It answers the `initialize` handshake immediately and builds the index in the background, so searches return empty / graph queries report "not built yet" until the first build completes.

### Dependency graph

The graph has two granularities, kept in the same `index.db`:

**File-level** (stored as a JSON document in `graph_doc`; no embeddings needed — queries load the document and do direct lookups in memory):

- **Import edges** — TypeScript AST parses every file to extract `import` statements; relative imports resolve to actual file paths. Named imports are tracked per edge.
- **Type & symbol consumers** — Reverse index from a type name (and from a qualified `defFile::name`) to every file that imports it. Use this before modifying a type to find all downstream consumers.
- **Co-change pairs** — Mines `git log` for files that change together, filtering merge commits and large refactors.
- **HEAD SHA** — The graph records the git HEAD it was built against, so partitions can be stamped/validated.

**Symbol-level** (stored in relational tables: `symbol_nodes`, `symbol_edges`, `semantic_edges`), powering `query_symbol`:

- **Structural edges (exact).** A real `ts.Program` + TypeChecker resolves references between declarations — `calls`, `extends`, `implements`, `uses-type` — across files, through imports and aliases. Nodes are classes / functions / methods / interfaces / types / enums, keyed `file::name` (methods `file::Class.method`). This is ground truth, not a heuristic.
- **Semantic overlay (advisory).** For each indexed code chunk, the nearest *other-file* chunks (above a similarity threshold) are recorded as embedding-similarity edges between the symbols they cover. Like co-change, this is **advisory** — surfaced under a clearly separated heading, never gating anything.
- **Language extractors.** Structural extraction runs behind a `SymbolExtractor` registry; only TypeScript/JavaScript is implemented today. Other languages (Python/Java/Go, likely SCIP-backed) slot in as new extractors without changing callers.

**Auto-rebuild** — Both layers rebuild automatically when code files change (via the file watcher).

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
  index.ts        Entry point, MCP tool registration, stdio transport, startup
  types.ts        Shared TypeScript interfaces
  db.ts           bun:sqlite + sqlite-vec store: indexing, vector search, graph
  embeddings.ts   Embedding provider adapter (Ollama, TEI, OpenAI, ...)
  chunker.ts      AST-aware code chunking, markdown splitting
  graph.ts        File-level dependency graph extraction and co-change mining
  symbols.ts      Symbol-level structural graph (ts.Program + TypeChecker) + extractor registry
  partition.ts    File-level conflict gate and parallel-wave scheduler
  wiki.ts         Wiki CRUD operations and page management
  watcher.ts      File watcher with debounced re-indexing
```

### Data flow

```
Startup
  1. Load config (config file) + read env (REPO_ID, PROJECT_ROOT, REPO_CONTEXT_SQLITE)
  2. initDb: open .repo-context/index.db, load sqlite-vec, create chunks + vec0 + graph tables
  3. Initialize wiki directory
  4. Connect stdio transport — initialize handshake answered immediately
  5. Build index in background:
     a. Code files   -> AST chunking     -> embed -> chunks + vec0 (source='code')
     b. Doc files    -> heading split     -> embed -> chunks + vec0 (source='docs')
     c. Memory files -> frontmatter parse -> embed -> chunks + vec0 (source='memory')
     d. Wiki files   -> heading split     -> embed -> chunks + vec0 (source='wiki')
     e. Code files   -> AST import parse  -> graph_doc
     f. Git log      -> co-change mining  -> graph_doc
     g. Code files   -> ts.Program + checker -> symbol_nodes + symbol_edges
     h. Code vectors -> KNN per chunk     -> semantic_edges (advisory overlay)
  6. Start file watchers (debounced re-index + prune on changes)

Queries
  - search_* tools     -> embed query -> sqlite-vec cosine KNN (scoped by repo_id+source) -> results
  - query_deps/co/type -> load graph_doc -> direct lookup -> results
  - query_symbol       -> symbol_nodes/edges + semantic_edges -> definition + structural + advisory
  - partition          -> load graph_doc -> conflict graph + waves + advisory warnings
  - wiki CRUD          -> read/write files -> re-index wiki rows
```

## Development

### Tests

```sh
bun test
```

- **`src/partition.test.ts`** — pure unit tests for the conflict gate, wave scheduling, determinism, and advisory co-change overlay. Requires no external services.
- **`src/db.test.ts`** — integration tests for the sqlite-vec store and the dedup / upsert / prune / search lifecycle. They run a self-contained fake embedder (no Ollama needed) against a throwaway `index.db` in a temp dir, so they need no external services — just an extension-capable sqlite (Homebrew on macOS). The suite isolates itself under a dedicated `repo_id` and cleans up after each run.

### Type checking

```sh
bunx tsc --noEmit
```
