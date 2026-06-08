# CLAUDE.md

Guidance for AI agents (and humans) working **on** `repo-context-mcp-server`.
For what the project is and how to *use* it, see [`README.md`](./README.md) and
the [`docs/`](./docs/) guide. This file is operational: how to build, test, and
change the code without breaking its contracts.

## What this is

An MCP server that gives coding assistants deep context on a single repository
through four systems: **vector search** (code/docs/memory/wiki), a **dependency
graph** (TypeScript AST imports + git co-change), an **LLM wiki**, and a
**partition scheduler** for parallel-safe work. It runs as a **local stdio MCP
server** — one process per repo, JSON-RPC over stdin/stdout — with all vectors
and the graph in a single `.repo-context/index.db` (sqlite + sqlite-vec). No
Docker, no Postgres, no network listener. Embeddings come from a host embedder
(Ollama by default). Current version: see `package.json` (`26.06.2`).

## Commands

```sh
bun install            # install deps
bun test               # run the suite (src/partition.test.ts, src/db.test.ts)
bun run typecheck      # tsc --noEmit
bun run src/index.ts   # run the server against the cwd (the repo to index)
```

- Tests need **no external services**: `partition.test.ts` is pure; `db.test.ts`
  uses a self-contained fake embedder against a throwaway `index.db` in a temp
  dir under an isolated `repo_id`. They do need an **extension-capable sqlite**
  (`brew install sqlite` on macOS) so `sqlite-vec` can load.

## Source map

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: config resolution, MCP tool registration, stdio transport, background build, watcher startup |
| `src/types.ts` | Shared interfaces (`RepoConfig`, `DependencyGraph`, `GraphConfig`, …) |
| `src/db.ts` | sqlite + sqlite-vec store: indexing, dedup/upsert/prune, vector search, graph doc persistence |
| `src/embeddings.ts` | Embedding provider adapter (Ollama, TEI, OpenAI, Google, Mistral, LM Studio) + dimension derivation |
| `src/chunker.ts` | AST-aware code chunking, markdown/heading splitting, content hashing |
| `src/graph.ts` | Dependency graph: AST import edges, type/symbol consumers, git co-change mining |
| `src/partition.ts` | Pure file-level conflict gate + deterministic wave scheduler |
| `src/wiki.ts` | Wiki CRUD and page management |
| `src/watcher.ts` | Debounced file watcher → re-index + graph rebuild |

## Invariants — do not break these

- **stdout is the protocol.** Only JSON-RPC goes to stdout. **All logging goes to
  `console.error` (stderr).** A stray `console.log` corrupts the MCP stream.
- **One process serves one repo.** Multi-repo config exists, but a given process
  serves a single `repoId`. Rows are isolated by `repo_id`.
- **`partition.ts` must stay pure and deterministic.** Same inputs → same
  conflict graph, waves, and warnings. Issues and shared files are ordered before
  processing. No clock, no randomness, no I/O.
- **Co-change is advisory, never gating.** In `partition`, historical co-change
  surfaces as a warning only — it must never add a conflict edge or change the
  waves. Keep it that way.
- **The file-level gate is the only conflict rule.** Two issues conflict iff
  their file sets intersect. Don't add hidden gating heuristics.
- **One embedding model per store.** The vector column width is fixed at first
  build from the model's dimension. Changing models requires a fresh `repo_id` or
  a store rebuild (the store auto-rebuilds on dimension change).
- **Config defaults live in `src/index.ts`** (`DEFAULT_CODE_PATTERNS`,
  `DEFAULT_DOC_PATTERNS`, `DEFAULT_SKIP_PATTERNS`). If you change a default,
  update the config table in `README.md` to match. Note `config.example.json`
  intentionally shows a *customized* superset (adds `README.md`,
  `.claude/worktrees`, `.repo-context`), not the bare defaults.
- **The graph stamps HEAD.** `buildGraph` records the git HEAD SHA so partitions
  can be validated against the tree they were computed for. Preserve that.

## Conventions

- TypeScript, ESM (`"type": "module"`), `.js` import specifiers that resolve to
  `.ts` sources. Run `bun run typecheck` before considering a change done.
- Match the surrounding file's style: terse top-of-file comment block describing
  the module, section dividers (`// ---`), no incidental dependencies.
- Keep changes grounded — verify against the AST/git behavior in `graph.ts` and
  `db.ts` rather than assuming.

## Documentation map

When behavior changes, keep these in sync:

- [`README.md`](./README.md) — reference: tools, config fields, transport, data flow.
- [`docs/getting-started.md`](./docs/getting-started.md) — install/connect + tool playbook.
- [`docs/why-semantic-driven-context.md`](./docs/why-semantic-driven-context.md) — design rationale.
