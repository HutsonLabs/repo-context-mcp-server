// types.ts — Shared types for repo-context MCP server

export interface EmbeddingProviderConfig {
  type: 'openai' | 'google' | 'ollama' | 'mistral' | 'lmstudio';
  apiKey: string | null;
  baseUrl?: string;
  model: string;
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
