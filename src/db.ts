// db.ts — Postgres + pgvector connection, schema management, search.
//
// Drop-in replacement for lancedb.ts. Replicates the dedup/prune/upsert
// semantics and function signatures exactly, so callers (index.ts, watcher.ts)
// can swap with only an import change. The `indexDir` parameter on the
// index/search/delete functions is IGNORED (kept for signature compatibility);
// connection state is established once via initDb().

import pg from 'pg';
import type {
  CodeRow,
  DocsRow,
  MemoryRow,
  WikiRow,
  EmbeddingProviderConfig,
  CodeSearchResult,
  DocsSearchResult,
  MemorySearchResult,
  WikiSearchResult,
} from './types.js';
import { embedBatch, embedSingle } from './embeddings.js';
import { chunkCode, chunkMarkdown, chunkMemory, chunkWiki, contentHash } from './chunker.js';
import { readFileSync, statSync, readdirSync } from 'node:fs';
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

let pool: pg.Pool | null = null;
let repoId: string | null = null;
let dim: number | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('db not initialized: call initDb() before any index/search operation');
  }
  return pool;
}

function getRepoId(): string {
  if (repoId == null) {
    throw new Error('db not initialized: call initDb() before any index/search operation');
  }
  return repoId;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initDb(opts: {
  connectionString: string;
  repoId: string;
  dim: number;
}): Promise<void> {
  if (!Number.isInteger(opts.dim) || opts.dim <= 0) {
    throw new Error(`initDb: dim must be a positive integer, got ${opts.dim}`);
  }

  pool = new pg.Pool({ connectionString: opts.connectionString });
  repoId = opts.repoId;
  dim = opts.dim;

  const d = opts.dim; // validated positive integer; safe to interpolate into DDL

  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           text NOT NULL,
      repo_id      text NOT NULL,
      source       text NOT NULL,
      file_path    text NOT NULL,
      chunk_index  int,
      section      text,
      name         text,
      type         text,
      exports      text,
      imports      text,
      chunk_text   text NOT NULL,
      content_hash text NOT NULL,
      mtime        double precision,
      embedding    vector(${d}) NOT NULL,
      PRIMARY KEY (repo_id, source, id)
    )
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS chunks_lookup ON chunks (repo_id, source, file_path)`,
  );
}

// ---------------------------------------------------------------------------
// Internal row shape (mirrors CodeRow/DocsRow/MemoryRow/WikiRow but unified)
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
  _indexDir: string,
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

  const pruned = await pruneDeletedFiles(CODE_SOURCE, new Set(files));
  if (pruned > 0) {
    console.error(`[index] Pruned ${pruned} deleted code file(s) from index`);
  }

  const existing = await getExistingHashes(CODE_SOURCE);

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

  await upsertRows(CODE_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} code chunks`);
  return fullRows.length;
}

export async function indexDocs(
  projectRoot: string,
  _indexDir: string,
  config: EmbeddingProviderConfig,
  docPatterns: string[],
): Promise<number> {
  const docPaths: string[] = [];
  for (const pattern of docPatterns) {
    for (const path of globSync(pattern, projectRoot)) {
      if (!docPaths.includes(path)) docPaths.push(path);
    }
  }

  const prunedDocs = await pruneDeletedFiles(DOCS_SOURCE, new Set(docPaths));
  if (prunedDocs > 0) {
    console.error(`[index] Pruned ${prunedDocs} deleted doc file(s) from index`);
  }

  const existing = await getExistingHashes(DOCS_SOURCE);
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

  await upsertRows(DOCS_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} doc chunks`);
  return fullRows.length;
}

export async function indexMemory(
  memoryDir: string,
  _indexDir: string,
  config: EmbeddingProviderConfig,
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    console.error('[index] Memory directory not found, skipping');
    return 0;
  }

  const prunedMem = await pruneDeletedFiles(MEMORY_SOURCE, new Set(entries));
  if (prunedMem > 0) {
    console.error(`[index] Pruned ${prunedMem} deleted memory file(s) from index`);
  }

  const existing = await getExistingHashes(MEMORY_SOURCE);
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

  await upsertRows(MEMORY_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} memory chunks`);
  return fullRows.length;
}

export async function indexWiki(
  wikiDir: string,
  _indexDir: string,
  config: EmbeddingProviderConfig,
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(wikiDir).filter((f) => f.endsWith('.md'));
  } catch {
    console.error('[index] Wiki directory not found, skipping');
    return 0;
  }

  const prunedWiki = await pruneDeletedFiles(WIKI_SOURCE, new Set(entries));
  if (prunedWiki > 0) {
    console.error(`[index] Pruned ${prunedWiki} deleted wiki file(s) from index`);
  }

  const existing = await getExistingHashes(WIKI_SOURCE);
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

  await upsertRows(WIKI_SOURCE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} wiki chunks`);
  return fullRows.length;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchCode(
  query: string,
  config: EmbeddingProviderConfig,
  _indexDir: string,
  k: number = 5,
  fileFilter?: string,
): Promise<CodeSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const vecLiteral = toVectorLiteral(queryVec);

  const limit = fileFilter ? k * 3 : k;
  const { rows } = await getPool().query(
    `SELECT file_path, chunk_text, section, name, type, exports,
            1 - (embedding <=> $1::vector) AS score
       FROM chunks
      WHERE repo_id = $2 AND source = $3
      ORDER BY embedding <=> $1::vector
      LIMIT ${limit}`,
    [vecLiteral, getRepoId(), CODE_SOURCE],
  );

  let filtered = rows;
  if (fileFilter) {
    const pattern = new Glob(fileFilter);
    filtered = rows.filter((r: any) => pattern.match(r.file_path));
    filtered = filtered.slice(0, k);
  }

  return filtered.map((r: any) => ({
    file: r.file_path,
    chunk: r.chunk_text,
    exports: r.exports,
    score: r.score != null ? Number(r.score) : 0,
  }));
}

export async function searchDocs(
  query: string,
  config: EmbeddingProviderConfig,
  _indexDir: string,
  k: number = 3,
): Promise<DocsSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const vecLiteral = toVectorLiteral(queryVec);

  const { rows } = await getPool().query(
    `SELECT file_path, chunk_text, section, name, type, exports,
            1 - (embedding <=> $1::vector) AS score
       FROM chunks
      WHERE repo_id = $2 AND source = $3
      ORDER BY embedding <=> $1::vector
      LIMIT ${k}`,
    [vecLiteral, getRepoId(), DOCS_SOURCE],
  );

  return rows.map((r: any) => ({
    file: r.file_path,
    section: r.section,
    chunk: r.chunk_text,
    score: r.score != null ? Number(r.score) : 0,
  }));
}

export async function searchMemory(
  query: string,
  config: EmbeddingProviderConfig,
  _indexDir: string,
  k: number = 3,
  typeFilter?: string,
): Promise<MemorySearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const vecLiteral = toVectorLiteral(queryVec);

  const limit = typeFilter ? k * 3 : k;
  const params: unknown[] = [vecLiteral, getRepoId(), MEMORY_SOURCE];
  let typeClause = '';
  if (typeFilter) {
    params.push(typeFilter);
    typeClause = ` AND type = $${params.length}`;
  }

  const { rows } = await getPool().query(
    `SELECT file_path, chunk_text, section, name, type, exports,
            1 - (embedding <=> $1::vector) AS score
       FROM chunks
      WHERE repo_id = $2 AND source = $3${typeClause}
      ORDER BY embedding <=> $1::vector
      LIMIT ${limit}`,
    params,
  );

  let filtered = rows;
  if (typeFilter) {
    filtered = rows.filter((r: any) => r.type === typeFilter);
    filtered = filtered.slice(0, k);
  }

  return filtered.map((r: any) => ({
    file: r.file_path,
    name: r.name,
    type: r.type,
    chunk: r.chunk_text,
    score: r.score != null ? Number(r.score) : 0,
  }));
}

export async function searchWiki(
  query: string,
  config: EmbeddingProviderConfig,
  _indexDir: string,
  k: number = 3,
): Promise<WikiSearchResult[]> {
  const queryVec = await embedSingle(query, config, 'query');
  const vecLiteral = toVectorLiteral(queryVec);

  const { rows } = await getPool().query(
    `SELECT file_path, chunk_text, section, name, type, exports,
            1 - (embedding <=> $1::vector) AS score
       FROM chunks
      WHERE repo_id = $2 AND source = $3
      ORDER BY embedding <=> $1::vector
      LIMIT ${k}`,
    [vecLiteral, getRepoId(), WIKI_SOURCE],
  );

  return rows.map((r: any) => ({
    file: r.file_path,
    section: r.section,
    chunk: r.chunk_text,
    score: r.score != null ? Number(r.score) : 0,
  }));
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

function toVectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

async function getExistingHashes(source: Source): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { rows } = await getPool().query(
    `SELECT file_path, content_hash FROM chunks WHERE repo_id = $1 AND source = $2`,
    [getRepoId(), source],
  );
  for (const row of rows as Array<{ file_path: string; content_hash: string }>) {
    map.set(row.file_path, row.content_hash);
  }
  return map;
}

async function upsertRows(source: Source, rows: ChunkInsert[]): Promise<void> {
  if (rows.length === 0) return;

  const rid = getRepoId();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Delete existing rows for each changed file_path, then re-insert.
    const filePaths = [...new Set(rows.map((r) => r.file_path))];
    for (const fp of filePaths) {
      await client.query(
        `DELETE FROM chunks WHERE repo_id = $1 AND source = $2 AND file_path = $3`,
        [rid, source, fp],
      );
    }

    // Multi-row batched INSERT.
    const COLS_PER_ROW = 14;
    const BATCH = 200;
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      const valueGroups: string[] = [];
      const params: unknown[] = [];
      for (const r of batch) {
        const base = params.length;
        const placeholders: string[] = [];
        for (let c = 0; c < COLS_PER_ROW; c++) {
          // The embedding column (last) is cast to ::vector.
          if (c === COLS_PER_ROW - 1) {
            placeholders.push(`$${base + c + 1}::vector`);
          } else {
            placeholders.push(`$${base + c + 1}`);
          }
        }
        valueGroups.push(`(${placeholders.join(',')})`);
        params.push(
          r.id,
          rid,
          source,
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
          toVectorLiteral(r.vector),
        );
      }
      await client.query(
        `INSERT INTO chunks
           (id, repo_id, source, file_path, chunk_index, section, name, type,
            exports, imports, chunk_text, content_hash, mtime, embedding)
         VALUES ${valueGroups.join(',')}
         ON CONFLICT (repo_id, source, id) DO UPDATE SET
           file_path = EXCLUDED.file_path,
           chunk_index = EXCLUDED.chunk_index,
           section = EXCLUDED.section,
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           exports = EXCLUDED.exports,
           imports = EXCLUDED.imports,
           chunk_text = EXCLUDED.chunk_text,
           content_hash = EXCLUDED.content_hash,
           mtime = EXCLUDED.mtime,
           embedding = EXCLUDED.embedding`,
        params,
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Remove all rows for files that are no longer present on disk. Runs on every
// re-index so deletions made while the server was dead (or that chokidar
// missed) get cleaned up. Returns the number of distinct file paths pruned.
async function pruneDeletedFiles(source: Source, presentFiles: Set<string>): Promise<number> {
  const rid = getRepoId();
  const { rows } = await getPool().query(
    `SELECT DISTINCT file_path FROM chunks WHERE repo_id = $1 AND source = $2`,
    [rid, source],
  );
  const indexed = new Set<string>();
  for (const r of rows as Array<{ file_path?: string }>) {
    if (r.file_path) indexed.add(r.file_path);
  }
  const toDelete: string[] = [];
  for (const fp of indexed) {
    if (!presentFiles.has(fp)) toDelete.push(fp);
  }
  for (const fp of toDelete) {
    await getPool().query(
      `DELETE FROM chunks WHERE repo_id = $1 AND source = $2 AND file_path = $3`,
      [rid, source, fp],
    );
  }
  return toDelete.length;
}

// Remove rows for a single file path. Used by the watcher's unlink handler
// to reflect deletions immediately (before the debounced re-index fires).
export async function deleteFileFromTable(
  _indexDir: string,
  tableName: 'code' | 'docs' | 'memory' | 'wiki',
  filePath: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM chunks WHERE repo_id = $1 AND source = $2 AND file_path = $3`,
    [getRepoId(), tableName, filePath],
  );
}
