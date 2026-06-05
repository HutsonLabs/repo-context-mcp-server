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

export interface ServerConfig {
  embedding: EmbeddingProviderConfig;
  /** Absolute path to project root (defaults to process.cwd()) */
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
// LanceDB table row types
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
