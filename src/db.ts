// db.ts — bun:sqlite + sqlite-vec connection, schema management, search.
//
// A single local sqlite file (default: <indexDir>/index.db) holds everything:
//   * `chunks`      — relational metadata for every indexed chunk (for dedup,
//                     prune, and delete-by-file). One row per chunk.
//   * `vec_chunks`  — a sqlite-vec `vec0` virtual table holding the embedding,
//                     keyed by the same rowid as `chunks`, with `repo_id` and
//                     `source` as filterable metadata columns. Cosine distance.
//   * `graph_doc`   — the dependency graph, one JSON document per repo.
//   * `meta`        — key/value bag (currently the embedding dimension).
//
// sqlite-vec is a loadable extension. macOS ships a libsqlite3 with extension
// loading compiled out, so we point bun:sqlite at a Homebrew sqlite via
// `Database.setCustomSQLite()` before opening the database. Override the dylib
// with `REPO_CONTEXT_SQLITE` (or initDb's `sqlitePath`) if auto-detection misses.
//
// Connection state (db handle + embedding dimension) is established once via
// initDb() and shared across the process. Every index/search/delete function
// takes a `repoId` so rows stay scoped even though one file could host several.

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import type {
  EmbeddingProviderConfig,
  CodeSearchResult,
  DocsSearchResult,
  MemorySearchResult,
  WikiSearchResult,
  DependencyGraph,
} from './types.js';
import { embedBatch, embedSingle } from './embeddings.js';
import { chunkCode, chunkMarkdown, chunkMemory, chunkWiki, contentHash } from './chunker.js';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

type Source = 'code' | 'docs' | 'memory' | 'wiki';

const CODE_SOURCE: Source = 'code';
const DOCS_SOURCE: Source = 'docs';
const MEMORY_SOURCE: Source = 'memory';
const WIKI_SOURCE: Source = 'wiki';

let db: Database | null = null;
let dim: number | null = null;
let customSqliteSet = false;

function getDb(): Database {
  if (!db) {
    throw new Error('db not initialized: call initDb() before any index/search operation');
  }
  return db;
}

// ---------------------------------------------------------------------------
// sqlite-vec loading
// ---------------------------------------------------------------------------

// Candidate Homebrew sqlite dylibs (Apple Silicon, then Intel). The default
// macOS libsqlite3 cannot load extensions; these builds can.
const SQLITE_DYLIB_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
];

function pointAtExtensionCapableSqlite(override?: string): void {
  if (customSqliteSet) return;
  const explicit = override ?? process.env.REPO_CONTEXT_SQLITE;
  const candidates = explicit ? [explicit] : SQLITE_DYLIB_CANDIDATES;
  for (const path of candidates) {
    if (existsSync(path)) {
      Database.setCustomSQLite(path);
      customSqliteSet = true;
      return;
    }
  }
  // On Linux the bundled sqlite usually supports extension loading, so a missing
  // dylib is fine. On macOS it is not — surface a clear hint if load() later fails.
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initDb(opts: {
  dbPath: string;
  dim: number;
  sqlitePath?: string;
}): Promise<void> {
  if (!Number.isInteger(opts.dim) || opts.dim <= 0) {
    throw new Error(`initDb: dim must be a positive integer, got ${opts.dim}`);
  }

  pointAtExtensionCapableSqlite(opts.sqlitePath);

  if (db) {
    db.close();
    db = null;
  }

  const handle = new Database(opts.dbPath, { create: true });
  try {
    sqliteVec.load(handle);
  } catch (err) {
    throw new Error(
      `Failed to load the sqlite-vec extension. On macOS install an extension-capable ` +
        `sqlite ("brew install sqlite") or set REPO_CONTEXT_SQLITE to a libsqlite3 that ` +
        `supports loadExtension. Original error: ${(err as Error).message}`,
    );
  }

  handle.run('PRAGMA journal_mode = WAL');
  handle.run('PRAGMA synchronous = NORMAL');
  handle.run('PRAGMA foreign_keys = ON');

  db = handle;
  dim = opts.dim;

  handle.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  // Embedding dimension is baked into the vec0 table DDL. If the stored
  // dimension no longer matches (model changed), the old vectors are unusable —
  // drop and rebuild from scratch rather than failing every insert.
  const storedDim = readMetaInt('dim');
  if (storedDim !== null && storedDim !== opts.dim) {
    console.error(
      `[db] embedding dimension changed (${storedDim} -> ${opts.dim}); rebuilding index store`,
    );
    handle.run('DROP TABLE IF EXISTS vec_chunks');
    handle.run('DROP TABLE IF EXISTS chunks');
    handle.run('DROP TABLE IF EXISTS graph_doc');
  }

  handle.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      repo_id      TEXT NOT NULL,
      source       TEXT NOT NULL,
      id           TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      chunk_index  INTEGER,
      section      TEXT,
      name         TEXT,
      type         TEXT,
      exports      TEXT,
      imports      TEXT,
      chunk_text   TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      mtime        REAL,
      UNIQUE (repo_id, source, id)
    )
  `);
  handle.run(
    `CREATE INDEX IF NOT EXISTS chunks_lookup ON chunks (repo_id, source, file_path)`,
  );

  handle.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding FLOAT[${opts.dim}] distance_metric=cosine,
      repo_id TEXT,
      source TEXT
    )
  `);

  handle.run(`
    CREATE TABLE IF NOT EXISTS graph_doc (
      repo_id TEXT PRIMARY KEY,
      doc     TEXT NOT NULL
    )
  `);

  writeMeta('dim', String(opts.dim));
}

/** Close the database (used by tests and graceful shutdown). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dim = null;
  }
}

function readMetaInt(key: string): number | null {
  const row = getDb().query('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function writeMeta(key: string, value: string): void {
  getDb().run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface ChunkInsert {
  id: string;
  file_path: string;
  chunk_index: number | null;
  section: string | null;
  name: string | null;
  type: string | null;
  exports: string | null;
  imports: string | null;
  chunk_text: string;
  content_hash: string;
  mtime: number;
  vector: number[];
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

export async function indexCode(
  projectRoot: string,
  repoId: string,
  config: EmbeddingProviderConfig,
  codePatterns: string[],
  skipPatterns: string[],
): Promise<number> {
  const files: string[] = [];
  for (const pattern of codePatterns) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: projectRoot, absolute: false, onlyFiles: true })) {
      if (shouldSkipFile(path, skipPatterns)) continue;
      if (!files.includes(path)) files.push(path);
    }
  }

  console.error(`[index] Found ${files.length} code files`);

  const pruned = pruneDeletedFiles(repoId, CODE_SOURCE, new Set(files));
  if (pruned > 0) {
    console.error(`[index] Pruned ${pruned} deleted code file(s) from index`);
  }

  const existing = getExistingHashes(repoId, CODE_SOURCE);

  const rows: Array<Omit<ChunkInsert, 'vector'>> = [];
  const texts: string[] = [];

  for (const filePath of files) {
    const absPath = resolve(projectRoot, filePath);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const hash = contentHash(content);
    if (existing.get(filePath) === hash) continue;

    const mtime = statSync(absPath).mtimeMs;
    const chunks = chunkCode(content, filePath);

    for (const chunk of chunks) {
      rows.push({
        id: `${filePath}:${chunk.chunkIndex}`,
        file_path: filePath,
        chunk_index: chunk.chunkIndex,
        section: null,
        name: null,
        type: null,
        exports: chunk.exports,
        imports: chunk.imports,
        chunk_text: chunk.chunkText,
        content_hash: hash,
        mtime,
      });
      texts.push(chunk.chunkText);
    }
  }

  if (rows.length === 0) {
    console.error('[index] Code table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} code chunks...`);
  const vectors = await embedBatch(texts, config, 'document');

  const fullRows: ChunkInsert[] = rows.map((row, i) => ({ ...row, vector: vectors[i] }));

  upsertRows(repoId, CODE_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} code chunks`);
  return fullRows.length;
}

export async function indexDocs(
  projectRoot: string,
  repoId: string,
  config: EmbeddingProviderConfig,
  docPatterns: string[],
): Promise<number> {
  const docPaths: string[] = [];
  for (const pattern of docPatterns) {
    for (const path of globSync(pattern, projectRoot)) {
      if (!docPaths.includes(path)) docPaths.push(path);
    }
  }

  const prunedDocs = pruneDeletedFiles(repoId, DOCS_SOURCE, new Set(docPaths));
  if (prunedDocs > 0) {
    console.error(`[index] Pruned ${prunedDocs} deleted doc file(s) from index`);
  }

  const existing = getExistingHashes(repoId, DOCS_SOURCE);
  const rows: Array<Omit<ChunkInsert, 'vector'>> = [];
  const texts: string[] = [];

  for (const filePath of docPaths) {
    const absPath = resolve(projectRoot, filePath);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const hash = contentHash(content);
    if (existing.get(filePath) === hash) continue;

    const mtime = statSync(absPath).mtimeMs;
    const chunks = chunkMarkdown(content);

    for (const chunk of chunks) {
      rows.push({
        id: `${filePath}:${chunk.section}`,
        file_path: filePath,
        chunk_index: null,
        section: chunk.section,
        name: null,
        type: null,
        exports: null,
        imports: null,
        chunk_text: chunk.chunkText,
        content_hash: hash,
        mtime,
      });
      texts.push(chunk.chunkText);
    }
  }

  if (rows.length === 0) {
    console.error('[index] Docs table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} doc chunks...`);
  const vectors = await embedBatch(texts, config, 'document');

  const fullRows: ChunkInsert[] = rows.map((row, i) => ({ ...row, vector: vectors[i] }));

  upsertRows(repoId, DOCS_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} doc chunks`);
  return fullRows.length;
}

export async function indexMemory(
  memoryDir: string,
  repoId: string,
  config: EmbeddingProviderConfig,
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    console.error('[index] Memory directory not found, skipping');
    return 0;
  }

  const prunedMem = pruneDeletedFiles(repoId, MEMORY_SOURCE, new Set(entries));
  if (prunedMem > 0) {
    console.error(`[index] Pruned ${prunedMem} deleted memory file(s) from index`);
  }

  const existing = getExistingHashes(repoId, MEMORY_SOURCE);
  const rows: Array<Omit<ChunkInsert, 'vector'>> = [];
  const texts: string[] = [];

  for (const file of entries) {
    const absPath = join(memoryDir, file);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const hash = contentHash(content);
    if (existing.get(file) === hash) continue;

    const mtime = statSync(absPath).mtimeMs;
    const { chunk, frontmatter } = chunkMemory(content);

    rows.push({
      id: file,
      file_path: file,
      chunk_index: null,
      section: null,
      name: frontmatter.name,
      type: frontmatter.type,
      exports: null,
      imports: null,
      chunk_text: chunk.chunkText,
      content_hash: hash,
      mtime,
    });
    texts.push(chunk.chunkText);
  }

  if (rows.length === 0) {
    console.error('[index] Memory table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} memory chunks...`);
  const vectors = await embedBatch(texts, config, 'document');

  const fullRows: ChunkInsert[] = rows.map((row, i) => ({ ...row, vector: vectors[i] }));

  upsertRows(repoId, MEMORY_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} memory chunks`);
  return fullRows.length;
}

export async function indexWiki(
  wikiDir: string,
  repoId: string,
  config: EmbeddingProviderConfig,
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(wikiDir).filter((f) => f.endsWith('.md'));
  } catch {
    console.error('[index] Wiki directory not found, skipping');
    return 0;
  }

  const prunedWiki = pruneDeletedFiles(repoId, WIKI_SOURCE, new Set(entries));
  if (prunedWiki > 0) {
    console.error(`[index] Pruned ${prunedWiki} deleted wiki file(s) from index`);
  }

  const existing = getExistingHashes(repoId, WIKI_SOURCE);
  const rows: Array<Omit<ChunkInsert, 'vector'>> = [];
  const texts: string[] = [];

  for (const file of entries) {
    const absPath = join(wikiDir, file);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const hash = contentHash(content);
    if (existing.get(file) === hash) continue;

    const mtime = statSync(absPath).mtimeMs;
    const chunks = chunkWiki(content);

    for (const chunk of chunks) {
      rows.push({
        id: `${file}:${chunk.section}`,
        file_path: file,
        chunk_index: null,
        section: chunk.section,
        name: null,
        type: null,
        exports: null,
        imports: null,
        chunk_text: chunk.chunkText,
        content_hash: hash,
        mtime,
      });
      texts.push(chunk.chunkText);
    }
  }

  if (rows.length === 0) {
    console.error('[index] Wiki table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} wiki chunks...`);
  const vectors = await embedBatch(texts, config, 'document');

  const fullRows: ChunkInsert[] = rows.map((row, i) => ({ ...row, vector: vectors[i] }));

  upsertRows(repoId, WIKI_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} wiki chunks`);
  return fullRows.length;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchRow {
  file_path: string;
  chunk_text: string;
  section: string | null;
  name: string | null;
  type: string | null;
  exports: string | null;
  distance: number;
}

// KNN over vec_chunks filtered by repo_id + source, joined back to chunks for
// the returnable metadata. sqlite-vec requires `embedding match ?` paired with a
// bound `k = ?`. score = 1 - cosine_distance (matches the prior pgvector `<=>`).
function knn(repoId: string, source: Source, queryVec: number[], k: number): SearchRow[] {
  const blob = toBlob(queryVec);
  return getDb()
    .query(
      `SELECT c.file_path, c.chunk_text, c.section, c.name, c.type, c.exports,
              v.distance AS distance
         FROM vec_chunks v
         JOIN chunks c ON c.rowid = v.rowid
        WHERE v.repo_id = ? AND v.source = ? AND v.embedding MATCH ? AND k = ?
        ORDER BY v.distance`,
    )
    .all(repoId, source, blob, k) as SearchRow[];
}

export async function searchCode(
  query: string,
  config: EmbeddingProviderConfig,
  repoId: string,
  k: number = 5,
  fileFilter?: string,
): Promise<CodeSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const limit = fileFilter ? k * 3 : k;
  let rows = knn(repoId, CODE_SOURCE, queryVec, limit);

  if (fileFilter) {
    const pattern = new Glob(fileFilter);
    rows = rows.filter((r) => pattern.match(r.file_path)).slice(0, k);
  }

  return rows.map((r) => ({
    file: r.file_path,
    chunk: r.chunk_text,
    exports: r.exports ?? '',
    score: scoreFromDistance(r.distance),
  }));
}

export async function searchDocs(
  query: string,
  config: EmbeddingProviderConfig,
  repoId: string,
  k: number = 3,
): Promise<DocsSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const rows = knn(repoId, DOCS_SOURCE, queryVec, k);

  return rows.map((r) => ({
    file: r.file_path,
    section: r.section ?? '',
    chunk: r.chunk_text,
    score: scoreFromDistance(r.distance),
  }));
}

export async function searchMemory(
  query: string,
  config: EmbeddingProviderConfig,
  repoId: string,
  k: number = 3,
  typeFilter?: string,
): Promise<MemorySearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const limit = typeFilter ? k * 3 : k;
  let rows = knn(repoId, MEMORY_SOURCE, queryVec, limit);

  if (typeFilter) {
    rows = rows.filter((r) => r.type === typeFilter).slice(0, k);
  }

  return rows.map((r) => ({
    file: r.file_path,
    name: r.name ?? '',
    type: r.type ?? '',
    chunk: r.chunk_text,
    score: scoreFromDistance(r.distance),
  }));
}

export async function searchWiki(
  query: string,
  config: EmbeddingProviderConfig,
  repoId: string,
  k: number = 3,
): Promise<WikiSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const rows = knn(repoId, WIKI_SOURCE, queryVec, k);

  return rows.map((r) => ({
    file: r.file_path,
    section: r.section ?? '',
    chunk: r.chunk_text,
    score: scoreFromDistance(r.distance),
  }));
}

// ---------------------------------------------------------------------------
// Dependency graph persistence (folded into the same sqlite file)
// ---------------------------------------------------------------------------

export function saveGraph(repoId: string, graph: DependencyGraph): void {
  getDb().run(
    `INSERT INTO graph_doc (repo_id, doc) VALUES (?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET doc = excluded.doc`,
    [repoId, JSON.stringify(graph)],
  );
}

export function loadGraphDoc(repoId: string): DependencyGraph | null {
  const row = getDb().query('SELECT doc FROM graph_doc WHERE repo_id = ?').get(repoId) as
    | { doc: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.doc) as DependencyGraph;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldSkipFile(path: string, skipPatterns: string[]): boolean {
  return skipPatterns.some((pattern) => path.includes(pattern));
}

function globSync(pattern: string, cwd: string): string[] {
  const glob = new Glob(pattern);
  const results: string[] = [];
  for (const path of glob.scanSync({ cwd, absolute: false, onlyFiles: true })) {
    results.push(path);
  }
  return results;
}

/** Pack an embedding into the little-endian float32 blob sqlite-vec expects. */
function toBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

function scoreFromDistance(distance: number): number {
  const score = 1 - distance;
  return Number.isFinite(score) ? score : 0;
}

function getExistingHashes(repoId: string, source: Source): Map<string, string> {
  const map = new Map<string, string>();
  const rows = getDb()
    .query(`SELECT file_path, content_hash FROM chunks WHERE repo_id = ? AND source = ?`)
    .all(repoId, source) as Array<{ file_path: string; content_hash: string }>;
  for (const row of rows) {
    map.set(row.file_path, row.content_hash);
  }
  return map;
}

// Delete every chunk row (and its vector) for a set of file paths, scoped to
// repo + source. Returns nothing; callers count separately.
function deleteFilePaths(repoId: string, source: Source, filePaths: string[]): void {
  const handle = getDb();
  const rowsForFile = handle.query(
    `SELECT rowid FROM chunks WHERE repo_id = ? AND source = ? AND file_path = ?`,
  );
  const delVec = handle.query(`DELETE FROM vec_chunks WHERE rowid = ?`);
  const delChunk = handle.query(`DELETE FROM chunks WHERE rowid = ?`);
  for (const fp of filePaths) {
    const ids = rowsForFile.all(repoId, source, fp) as Array<{ rowid: number }>;
    for (const { rowid } of ids) {
      delVec.run(rowid);
      delChunk.run(rowid);
    }
  }
}

function upsertRows(repoId: string, source: Source, rows: ChunkInsert[]): void {
  if (rows.length === 0) return;

  const handle = getDb();
  const insChunk = handle.query(
    `INSERT INTO chunks
       (repo_id, source, id, file_path, chunk_index, section, name, type,
        exports, imports, chunk_text, content_hash, mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insVec = handle.query(
    `INSERT INTO vec_chunks (rowid, embedding, repo_id, source) VALUES (?, ?, ?, ?)`,
  );

  const txn = handle.transaction((batch: ChunkInsert[]) => {
    // Replace all chunks for each touched file, then re-insert.
    deleteFilePaths(repoId, source, [...new Set(batch.map((r) => r.file_path))]);

    for (const r of batch) {
      const res = insChunk.run(
        repoId,
        source,
        r.id,
        r.file_path,
        r.chunk_index,
        r.section,
        r.name,
        r.type,
        r.exports,
        r.imports,
        r.chunk_text,
        r.content_hash,
        r.mtime,
      );
      insVec.run(Number(res.lastInsertRowid), toBlob(r.vector), repoId, source);
    }
  });

  txn(rows);
}

// Remove all rows for files that are no longer present on disk. Runs on every
// re-index so deletions made while the server was dead (or that chokidar
// missed) get cleaned up. Returns the number of distinct file paths pruned.
function pruneDeletedFiles(repoId: string, source: Source, presentFiles: Set<string>): number {
  const rows = getDb()
    .query(`SELECT DISTINCT file_path FROM chunks WHERE repo_id = ? AND source = ?`)
    .all(repoId, source) as Array<{ file_path: string }>;
  const toDelete = rows.map((r) => r.file_path).filter((fp) => !presentFiles.has(fp));
  if (toDelete.length > 0) {
    const txn = getDb().transaction(() => deleteFilePaths(repoId, source, toDelete));
    txn();
  }
  return toDelete.length;
}

// Remove rows for a single file path. Used by the watcher's unlink handler to
// reflect deletions immediately (before the debounced re-index fires).
export function deleteFileFromTable(
  repoId: string,
  source: 'code' | 'docs' | 'memory' | 'wiki',
  filePath: string,
): void {
  const txn = getDb().transaction(() => deleteFilePaths(repoId, source, [filePath]));
  txn();
}
