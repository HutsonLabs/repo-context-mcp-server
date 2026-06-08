# Getting started

This guide takes you from zero to a working `repo-context` MCP server attached to
Claude Code, then gives a tool-by-tool playbook for *when* to reach for each tool
during real work.

For the full reference (every config field, the transport details, the data-flow
diagram), see the top-level [`README.md`](../README.md). This page is the
shortest path to something useful plus the judgment of how to use it.

---

## 1. Install the prerequisites

The server runs on [Bun](https://bun.sh) and indexes the repository it is
launched in. It needs three things on the host:

```sh
# 1. Bun — the runtime the server runs on
curl -fsSL https://bun.sh/install | bash

# 2. An extension-capable sqlite (macOS only).
#    The system libsqlite3 has extension loading compiled out, so sqlite-vec
#    can't load into it. Homebrew's build can. The server auto-detects it.
brew install sqlite

# 3. A host embedder. The default config targets Ollama.
brew install ollama
ollama serve                     # serves http://localhost:11434
ollama pull nomic-embed-text     # 768-dim text embeddings
```

> On Linux the bundled sqlite usually loads extensions, so step 2 is typically
> unnecessary. If auto-detection misses your sqlite, point at one explicitly
> with the `REPO_CONTEXT_SQLITE` env var.

---

## 2. Run it once by hand

Before wiring it into an MCP client, confirm it starts and builds an index. The
server indexes its **current working directory**, so `cd` into the repo you want
indexed first:

```sh
bun install                                   # in the repo-context-mcp-server dir
cd /path/to/your/project                      # the repo to index
bun run /path/to/repo-context-mcp-server/src/index.ts
```

What happens:

- It answers the MCP `initialize` handshake immediately.
- It builds the index **in the background** — vectors for code/docs/memory/wiki,
  plus the dependency graph. Searches return empty and graph queries report "not
  built yet" until that first build finishes.
- Everything lands in `<project>/.repo-context/index.db` — one sqlite file. No
  Docker, no Postgres, no network listener. Logs go to stderr; the stdout stream
  is reserved for the JSON-RPC protocol.

Press `Ctrl-C` to stop. You now have a warm index on disk that the next launch
reuses (only changed files get re-embedded).

---

## 3. Connect Claude Code

Add a stdio server entry to the **indexed project's** `.mcp.json`:

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
directory, so config resolution and the default project root both point at the
repo being worked on. Restart Claude Code; the tools below appear as
`repo-context` MCP tools.

> **One process per repo.** A stdio server serves a single repository. To index
> several, run one server per project — each project's `.mcp.json` launches its
> own. See [Multiple repositories](../README.md#multiple-repositories) for the
> `repos` config array and `REPO_ID` selection.

---

## 4. Make the agent reach for it first

Tools only help if the agent uses them before falling back to `grep`/`glob`. Add
this to the indexed project's `CLAUDE.md` so retrieval is the default move, not
an afterthought:

```markdown
## Context Retrieval

Always use the repo-context MCP tools **first** when exploring the codebase —
before Glob, Grep, or Read.

- `search_code` — find implementations, patterns, files
- `search_docs` — find architecture, standards, guidelines
- `search_memory` — find past decisions, feedback, project context
- `query_dependencies` — find what imports a file and what it imports
- `query_co_changes` — find files that change together
- `query_type_consumers` — find all consumers of a type before changing it
- `search_wiki` / `read_wiki_page` — find architectural decisions and tribal knowledge
```

Why this matters is the subject of [Why semantic-driven
context](./why-semantic-driven-context.md). In short: lexical search finds
strings; semantic search finds *meaning*, and the graph turns a hunch into a
verified set of edges.

---

## 5. Tool playbook — what to reach for, and when

The tools fall into two families with very different guarantees:

- **Search tools** (`search_*`) are **semantic and recall-oriented.** They embed
  your query and return the nearest chunks by cosine similarity. Great for
  discovery ("where does X happen?") even when you don't know the names. They
  rank by relevance; they don't prove anything.
- **Graph tools** (`query_*`, `partition`) are **structural and exact.** They are
  derived from the TypeScript AST and git history, so their answers are
  ground-truth edges, not guesses. Use them to *verify* and to *enumerate
  completely*.

The reliable pattern is **recall, then verify**: search to find the entry point,
then query the graph to map exactly what connects to it.

### Discovery — "where is this / how does this work?"

| Use | When |
|---|---|
| `search_code` | You want implementations, patterns, or files by behavior, not by name. "Where do we validate uploads?" finds the code even if the function is `checkPayload`. |
| `search_docs` | You want the architecture, a standard, or a guideline — the *intended* design, not the code. |
| `search_memory` | You want past decisions, prior feedback, or project context captured in Claude Code memory. "Why did we move off pgvector?" |
| `search_wiki` / `read_wiki_page` / `list_wiki_pages` | You want the tribal knowledge an agent or human deliberately wrote down — rationale, pitfalls, abandoned approaches. |

### Verification — "what exactly touches this?"

| Use | When |
|---|---|
| `query_dependencies` | You found a file and need its blast radius: what it imports, and (the part agents usually miss) **what imports it.** Set `depth > 1` to walk transitively. |
| `query_type_consumers` | **Before changing a type or interface.** Returns every file that imports it, including qualified `defFile::name` matches so same-named symbols from different files don't get conflated. This is the difference between a complete refactor and a broken build. |
| `query_co_changes` | You want files that *historically move together* in git, even with no import edge between them — config + the code it gates, a test + its fixture, a schema + its migration. Hidden coupling that static analysis can't see. |

### Planning parallel work — `partition`

`partition` answers: *given a batch of issues and the files each will touch,
which can be worked at the same time without colliding?*

- Feed it per-issue **touch sets** (the files each issue plans to modify).
- It returns a **conflict graph** (two issues conflict iff their file sets
  intersect) and a deterministic **wave schedule** — `Wave 1` is the independent
  set that can run in parallel; later waves wait on earlier ones.
- It also surfaces **hidden-coupling warnings** when two issues touch files that
  *historically co-change* — but these are **advisory only.** They never add a
  conflict edge or change the waves; they just tell a human to look.
- Same inputs always produce the same waves and warnings.

Use it to schedule multiple agents (or PRs) so they don't fight over the same
files.

---

## A worked example: changing a shared type safely

The whole point of the two-family design shows up in one common task — editing a
type that other code depends on:

1. **`search_code "the Foo config shape"`** — semantic recall finds the
   definition even though you didn't know it was called `RepoConfig`.
2. **`query_type_consumers "RepoConfig"`** — structural verification returns the
   *complete* list of files importing it. No `grep` false positives from
   comments or unrelated same-named symbols.
3. **`query_co_changes`** on the definition file — surfaces the migration script
   that always changes with it but has no import edge, so you don't forget it.
4. Make the change across exactly that set, confident it's the whole set.

Step 1 alone is a hunch. Steps 2–3 turn it into a verified boundary. That
recall-then-verify loop is why the structural graph and the semantic index are
both in the box — see [Why semantic-driven
context](./why-semantic-driven-context.md) for the full argument.

---

## Keeping the index fresh

You don't have to do anything. A debounced file watcher re-indexes on change,
re-embeds only files whose content hash changed, prunes rows for deleted files,
and rebuilds the dependency graph when code changes. The graph also records the
git HEAD it was built against, so partition results can be stamped and validated
against the tree they were computed for.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Searches return empty right after start | The background build hasn't finished. Wait for the first build; check stderr logs. |
| `loadExtension` / sqlite-vec errors on macOS | The system sqlite can't load extensions. `brew install sqlite`, or set `REPO_CONTEXT_SQLITE` to an extension-capable libsqlite3. |
| Embeddings fail / time out | The host embedder isn't reachable. Confirm `ollama serve` is up and the model is pulled, or point `embedding.baseUrl` at your provider. |
| Dimension mismatch after changing models | The vector column width is fixed at first build. Use a fresh `repo_id` or reset the `chunks` table; the store also auto-rebuilds when the configured model's dimension changes. |
