# repo-context-mcp-server

MCP server that gives AI coding assistants deep codebase context through three complementary systems:

1. **Vector search** — Semantic similarity search over code, docs, and memory
2. **Dependency graph** — Import edges, type consumers, and git co-change analysis
3. **LLM Wiki** — AI-maintained knowledge base for decisions and tribal knowledge

Uses LanceDB for vector storage, TypeScript AST for static analysis, and git history for co-change mining. Supports multiple embedding providers. Attach it to any repository and it bootstraps automatically.

## Tools

### Search (vector-based)

- **search_code** — Search source code for implementations, patterns, and files. Returns relevant chunks with file paths and exports.
- **search_docs** — Search project documentation for architecture, standards, and guidelines.
- **search_memory** — Search past decisions, feedback, and project context from Claude Code memory.

### Dependency graph (structural)

- **query_dependencies** — Find what a file imports and what imports it, with configurable traversal depth.
- **query_co_changes** — Find files that frequently change together in git history.
- **query_type_consumers** — Find where a type/interface is defined and which files consume it.

### Wiki (knowledge base)

- **search_wiki** — Semantic search across wiki pages.
- **read_wiki_page** — Read a specific wiki page by name.
- **write_wiki_page** — Create or update a wiki page.
- **list_wiki_pages** — List all wiki pages with summaries.

## Prerequisites

Install [Bun](https://bun.sh):

```sh
curl -fsSL https://bun.sh/install | bash
```

Install [Ollama](https://ollama.com) and pull the embedding model:

```sh
# macOS
brew install ollama

# Start Ollama (runs on http://localhost:11434)
ollama serve

# Pull the embedding model
ollama pull nomic-embed-text
```

## Install

```sh
git clone <repo-url>
cd repo-context-mcp-server
bun install
```

## Configure a repository

### 1. Add the MCP server to your project

From your project directory:

```sh
cd /path/to/your/project
claude mcp add repo-context -s project -- bun /path/to/repo-context-mcp-server/src/index.ts
```

This creates a `.mcp.json` file in your project root.

### 2. Create a config file

Create `repo-context.json` in your project root:

```json
{
  "embedding": {
    "type": "ollama",
    "apiKey": null,
    "baseUrl": "http://localhost:11434",
    "model": "nomic-embed-text"
  }
}
```

### 3. Add to .gitignore

```
.repo-context/
```

### 4. Restart Claude Code

The server connects immediately on startup. The initial index builds in the background — searches return empty results until indexing completes.

## Configuration

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
  "docPatterns": ["docs/*.md", "CLAUDE.md", ".claude/rules/*.md"],
  "skipPatterns": [
    "node_modules", ".next", "/dist/", "/build/",
    ".bundle.", ".min.", "__tests__", "__mocks__"
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
| `projectRoot` | `process.cwd()` | Override project root (auto-detected from MCP `cwd`) |
| `memoryDir` | auto-detected | Override Claude Code memory directory |
| `graph.coChangeMinCount` | `3` | Minimum co-occurrence count to record a co-change pair |
| `graph.coChangeMaxCommits` | `500` | How many commits to scan for co-change analysis |
| `wiki.autoInit` | `true` | Create wiki directory and index/log files on first run |

Config file resolution (first found wins):

1. `<cwd>/repo-context.json`
2. `<cwd>/.repo-context/config.json`
3. `<server-dir>/config.json`

## Embedding providers

| Provider | Model (default) | Dimensions | Config `type` |
|---|---|---|---|
| Ollama | nomic-embed-text | 768 | `ollama` |
| OpenAI | text-embedding-3-small | 1536 | `openai` |
| Google | text-embedding-004 | 768 | `google` |
| Mistral | mistral-embed | 1024 | `mistral` |
| LM Studio | (custom) | 768 | `lmstudio` |

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

- **Code indexing** — TypeScript AST-aware chunking splits at top-level declarations (functions, classes, interfaces, types). Falls back to sliding window (200 lines, 50-line overlap) for other file types. Max chunk size: 6,000 characters.
- **Doc indexing** — Splits markdown on `##` heading boundaries.
- **Memory indexing** — Indexes Claude Code memory files with YAML frontmatter parsing.
- **Wiki indexing** — Same heading-based splitting as docs, indexed into a separate LanceDB table.
- **Deduplication** — Content hashing (SHA-256) avoids re-embedding unchanged files.
- **File watching** — Chokidar watches for changes with 5-second debounce, re-indexes automatically.
- **Vector storage** — LanceDB stores embeddings locally in `.repo-context/` within the project.

### Dependency graph

The graph is built by static analysis and git history, stored as `.repo-context/graph.json`. No embeddings required — queries are direct lookups.

- **Import edges** — TypeScript AST parses every file to extract `import` statements. Relative imports are resolved to actual file paths. Named imports are tracked per edge.
- **Type exports** — Records which types, interfaces, enums, classes, and functions each file exports.
- **Type consumers** — Reverse index: given a type name, returns every file that imports it. Use this before modifying a type to find all downstream consumers.
- **Co-change pairs** — Mines `git log` for files that appear together in commits. Filters out merge commits and large refactors (>20 files). Pairs below the configured threshold are excluded.
- **Traversal** — `query_dependencies` supports multi-level depth traversal (e.g., depth=2 finds transitive dependencies).
- **Auto-rebuild** — The graph rebuilds automatically when code files change (via the file watcher).

### LLM Wiki

A structured, cross-linked knowledge base maintained by the AI assistant. Stored in `.repo-context/wiki/` as markdown files. Adapted from Andrej Karpathy's LLM Wiki pattern.

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

**Directory structure:**
```
.repo-context/wiki/
  index.md      — Table of contents (auto-created)
  log.md        — Append-only record of all operations (auto-created)
  *.md          — Wiki pages created by the AI assistant
```

## Architecture

```
src/
  index.ts        Entry point, MCP tool registration, startup
  types.ts        Shared TypeScript interfaces
  lancedb.ts      LanceDB connection, indexing, vector search
  embeddings.ts   Embedding provider adapter (Ollama, OpenAI, etc.)
  chunker.ts      AST-aware code chunking, markdown splitting
  graph.ts        Dependency graph extraction and co-change mining
  wiki.ts         Wiki CRUD operations and page management
  watcher.ts      File watcher with debounced re-indexing
```

### Data flow

```
Startup
  1. Load config (repo-context.json)
  2. Initialize wiki directory
  3. Connect MCP server (stdio transport)
  4. Build index in background:
     a. Code files -> AST chunking -> embed -> LanceDB (code table)
     b. Doc files -> heading split -> embed -> LanceDB (docs table)
     c. Memory files -> frontmatter parse -> embed -> LanceDB (memory table)
     d. Wiki files -> heading split -> embed -> LanceDB (wiki table)
     e. Code files -> AST import parse -> graph.json
     f. Git log -> co-change mining -> graph.json
  5. Start file watchers (debounced re-index on changes)

Queries
  - search_* tools -> embed query -> LanceDB vector search -> results
  - query_* tools -> load graph.json -> direct lookup -> results
  - wiki CRUD tools -> read/write files -> re-index wiki table
```
