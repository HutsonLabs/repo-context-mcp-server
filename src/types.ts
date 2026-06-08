// types.ts — Shared types for repo-context MCP server

export interface EmbeddingProviderConfig {
  type: 'openai' | 'google' | 'ollama' | 'mistral' | 'lmstudio' | 'tei';
  apiKey: string | null;
  baseUrl?: string;
  model: string;
}

export interface GraphConfig {
  /** Minimum number of co-occurrences in commits to count as a co-change pair (default: 3) */
  coChangeMinCount?: number;
  /** Maximum number of commits to scan for co-change analysis (default: 500) */
  coChangeMaxCommits?: number;
}

export interface WikiConfig {
  /** Auto-initialize wiki directory on first run (default: true) */
  autoInit?: boolean;
}

/**
 * One indexed repository in a multi-repo server. A client selects which repo a
 * request targets via the `X-Repo-Id` header; the server scopes all rows by
 * `repoId`. Indexing patterns/paths may be overridden per repo, otherwise the
 * server-level defaults apply.
 */
export interface RepoConfig {
  /** Logical id that isolates this repo's rows in the shared `chunks` table. */
  repoId: string;
  /** Absolute path to this repo's project root (the mounted source tree). */
  projectRoot: string;
  /** Absolute path to this repo's memory directory (auto-detected if omitted). */
  memoryDir?: string;
  /** Per-repo override of source code globs (falls back to server `codePatterns`). */
  codePatterns?: string[];
  /** Per-repo override of doc globs (falls back to server `docPatterns`). */
  docPatterns?: string[];
  /** Per-repo override of skip substrings (falls back to server `skipPatterns`). */
  skipPatterns?: string[];
  /** Per-repo override of dependency-graph settings. */
  graph?: GraphConfig;
  /** Per-repo override of wiki settings. */
  wiki?: WikiConfig;
}

export interface ServerConfig {
  embedding: EmbeddingProviderConfig;
  /**
   * Logical repo id for the single-repo (synthesized) case. Takes precedence
   * over the `REPO_ID` env var, so the served repo's identity comes from
   * `repo-context.json` rather than the environment. Ignored when `repos` is set.
   */
  name?: string;
  /**
   * Repositories served by this instance. A request picks one via the
   * `X-Repo-Id` header. When omitted, the server synthesizes a single repo
   * from the `PROJECT_ROOT` / `REPO_ID` env vars (single-repo back-compat),
   * which is also the default when a request sends no `X-Repo-Id`.
   *
   * NOTE: all repos share one `chunks` table and therefore one embedding
   * dimension — every repo must use the same server-level `embedding` model.
   */
  repos?: RepoConfig[];
  /** Absolute path to project root (defaults to process.cwd()) — single-repo fallback. */
  projectRoot?: string;
  /** Absolute path to memory directory (auto-detected from project path if omitted) */
  memoryDir?: string;
  /** Glob patterns for source code files (default: ["**\/*.{ts,tsx,js,jsx}"]) */
  codePatterns?: string[];
  /** Glob patterns for documentation files (default: ["docs\/*.md", "CLAUDE.md", ".claude/rules\/*.md"]) */
  docPatterns?: string[];
  /** Substrings in file paths to skip during indexing */
  skipPatterns?: string[];
  /** Dependency graph settings */
  graph?: GraphConfig;
  /** LLM Wiki settings */
  wiki?: WikiConfig;
}

// ---------------------------------------------------------------------------
// Index row types
// ---------------------------------------------------------------------------

export interface CodeRow {
  id: string;
  file_path: string;
  chunk_index: number;
  chunk_text: string;
  exports: string;
  imports: string;
  mtime: number;
  content_hash: string;
  vector: number[];
}

export interface DocsRow {
  id: string;
  file_path: string;
  section: string;
  chunk_text: string;
  mtime: number;
  content_hash: string;
  vector: number[];
}

export interface MemoryRow {
  id: string;
  file_path: string;
  name: string;
  type: string;
  description: string;
  chunk_text: string;
  mtime: number;
  content_hash: string;
  vector: number[];
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export interface CodeSearchResult {
  file: string;
  chunk: string;
  exports: string;
  score: number;
}

export interface DocsSearchResult {
  file: string;
  section: string;
  chunk: string;
  score: number;
}

export interface MemorySearchResult {
  file: string;
  name: string;
  type: string;
  chunk: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Dependency graph types
// ---------------------------------------------------------------------------

/** A single directed edge: source imports target */
export interface ImportEdge {
  source: string;
  target: string;
  /** Specific named imports (e.g., ["useState", "useEffect"]) */
  names: string[];
}

/** Files that frequently change together in git history */
export interface CoChangeEntry {
  fileA: string;
  fileB: string;
  /** Number of commits where both files changed */
  count: number;
}

/** Type/interface exported by a file */
export interface TypeExport {
  name: string;
  kind: 'type' | 'interface' | 'enum' | 'class' | 'function' | 'variable';
  file: string;
}

/** Full dependency graph stored as JSON */
export interface DependencyGraph {
  /** When this graph was last built */
  builtAt: string;
  /** Import edges: source -> targets */
  imports: Record<string, string[]>;
  /** Reverse edges: target -> importers */
  importedBy: Record<string, string[]>;
  /** Named imports per edge: "source::target" -> names[] */
  namedImports: Record<string, string[]>;
  /** Types/interfaces/enums exported per file */
  typeExports: Record<string, TypeExport[]>;
  /** Type name -> files that import/use it */
  typeConsumers: Record<string, string[]>;
  /** Qualified symbol "defFile::name" -> files that import/use it */
  symbolConsumers?: Record<string, string[]>;
  /** Co-change pairs from git history */
  coChanges: CoChangeEntry[];
  /** Git commit SHA at the time the graph was built */
  headSha?: string;
}

// ---------------------------------------------------------------------------
// Wiki types
// ---------------------------------------------------------------------------

export interface WikiRow {
  id: string;
  file_path: string;
  section: string;
  chunk_text: string;
  mtime: number;
  content_hash: string;
  vector: number[];
}

export interface WikiSearchResult {
  file: string;
  section: string;
  chunk: string;
  score: number;
}

export interface WikiPage {
  name: string;
  content: string;
  summary: string;
  lastUpdated: string;
  relatedPages: string[];
}
