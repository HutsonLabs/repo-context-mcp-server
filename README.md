# repo-context-mcp-server

MCP server that provides semantic code search, documentation search, and memory search for any repository. Uses LanceDB for vector storage and supports multiple embedding providers.

## Tools

- **search_code** — Search source code for implementations, patterns, and files. Returns relevant chunks with file paths and exports.
- **search_docs** — Search project documentation for architecture, standards, and guidelines.
- **search_memory** — Search past decisions, feedback, and project context from Claude Code memory.

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
git clone <repo-url> ~/repos/repo-context-mcp-server
cd ~/repos/repo-context-mcp-server
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
  ]
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

## How it works

- **Code indexing** — TypeScript AST-aware chunking splits at top-level declarations. Falls back to sliding window (200 lines, 50-line overlap) for other file types.
- **Doc indexing** — Splits markdown on `##` heading boundaries.
- **Memory indexing** — Indexes Claude Code memory files with YAML frontmatter parsing.
- **Deduplication** — Content hashing (SHA-256) avoids re-embedding unchanged files.
- **File watching** — Chokidar watches for changes with 5-second debounce, re-indexes automatically.
- **Vector storage** — LanceDB stores embeddings locally in `.repo-context/` within the project.
