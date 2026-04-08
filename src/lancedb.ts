// lancedb.ts — LanceDB connection, table management, search

import * as lancedb from '@lancedb/lancedb';
import type {
  CodeRow,
  DocsRow,
  MemoryRow,
  EmbeddingProviderConfig,
  CodeSearchResult,
  DocsSearchResult,
  MemorySearchResult,
} from './types.js';
import { embedBatch, embedSingle, getDimensions } from './embeddings.js';
import { chunkCode, chunkMarkdown, chunkMemory, contentHash } from './chunker.js';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let db: lancedb.Connection | null = null;

export async function connect(indexDir: string): Promise<lancedb.Connection> {
  if (db) return db;
  db = await lancedb.connect(indexDir);
  return db;
}

const CODE_TABLE = 'code';
const DOCS_TABLE = 'docs';
const MEMORY_TABLE = 'memory';

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

export async function indexCode(
  projectRoot: string,
  indexDir: string,
  config: EmbeddingProviderConfig,
  codePatterns: string[],
  skipPatterns: string[],
): Promise<number> {
  const conn = await connect(indexDir);

  const files: string[] = [];
  for (const pattern of codePatterns) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: projectRoot, absolute: false, onlyFiles: true })) {
      if (shouldSkipFile(path, skipPatterns)) continue;
      if (!files.includes(path)) files.push(path);
    }
  }

  console.error(`[index] Found ${files.length} code files`);

  const existing = await getExistingHashes(conn, CODE_TABLE);

  const rows: Array<Omit<CodeRow, 'vector'>> = [];
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
        chunk_text: chunk.chunkText,
        exports: chunk.exports,
        imports: chunk.imports,
        mtime,
        content_hash: hash,
      });
      texts.push(chunk.chunkText);
    }
  }

  if (rows.length === 0) {
    console.error('[index] Code table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} code chunks...`);
  const vectors = await embedBatch(texts, config);

  const fullRows: CodeRow[] = rows.map((row, i) => ({
    ...row,
    vector: vectors[i],
  }));

  await upsertRows(conn, CODE_TABLE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} code chunks`);
  return fullRows.length;
}

export async function indexDocs(
  projectRoot: string,
  indexDir: string,
  config: EmbeddingProviderConfig,
  docPatterns: string[],
): Promise<number> {
  const conn = await connect(indexDir);

  const docPaths: string[] = [];
  for (const pattern of docPatterns) {
    for (const path of globSync(pattern, projectRoot)) {
      if (!docPaths.includes(path)) docPaths.push(path);
    }
  }

  const existing = await getExistingHashes(conn, DOCS_TABLE);
  const rows: Array<Omit<DocsRow, 'vector'>> = [];
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
        section: chunk.section,
        chunk_text: chunk.chunkText,
        mtime,
        content_hash: hash,
      });
      texts.push(chunk.chunkText);
    }
  }

  if (rows.length === 0) {
    console.error('[index] Docs table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} doc chunks...`);
  const vectors = await embedBatch(texts, config);

  const fullRows: DocsRow[] = rows.map((row, i) => ({
    ...row,
    vector: vectors[i],
  }));

  await upsertRows(conn, DOCS_TABLE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} doc chunks`);
  return fullRows.length;
}

export async function indexMemory(
  memoryDir: string,
  indexDir: string,
  config: EmbeddingProviderConfig,
): Promise<number> {
  const conn = await connect(indexDir);

  let entries: string[];
  try {
    entries = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    console.error('[index] Memory directory not found, skipping');
    return 0;
  }

  const existing = await getExistingHashes(conn, MEMORY_TABLE);
  const rows: Array<Omit<MemoryRow, 'vector'>> = [];
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
      name: frontmatter.name,
      type: frontmatter.type,
      description: frontmatter.description,
      chunk_text: chunk.chunkText,
      mtime,
      content_hash: hash,
    });
    texts.push(chunk.chunkText);
  }

  if (rows.length === 0) {
    console.error('[index] Memory table up to date');
    return 0;
  }

  console.error(`[index] Embedding ${rows.length} memory chunks...`);
  const vectors = await embedBatch(texts, config);

  const fullRows: MemoryRow[] = rows.map((row, i) => ({
    ...row,
    vector: vectors[i],
  }));

  await upsertRows(conn, MEMORY_TABLE, fullRows);
  console.error(`[index] Indexed ${fullRows.length} memory chunks`);
  return fullRows.length;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchCode(
  query: string,
  config: EmbeddingProviderConfig,
  indexDir: string,
  k: number = 5,
  fileFilter?: string,
): Promise<CodeSearchResult[]> {
  const conn = await connect(indexDir);
  const queryVec = await embedSingle(query, config);

  let table: lancedb.Table;
  try {
    table = await conn.openTable(CODE_TABLE);
  } catch {
    return [];
  }

  const limit = fileFilter ? k * 3 : k;
  const results = await table.search(queryVec).limit(limit).toArray();

  let filtered = results;
  if (fileFilter) {
    const pattern = new Glob(fileFilter);
    filtered = results.filter((r: any) => pattern.match(r.file_path));
    filtered = filtered.slice(0, k);
  }

  return filtered.map((r: any) => ({
    file: r.file_path,
    chunk: r.chunk_text,
    exports: r.exports,
    score: r._distance != null ? 1 / (1 + r._distance) : 0,
  }));
}

export async function searchDocs(
  query: string,
  config: EmbeddingProviderConfig,
  indexDir: string,
  k: number = 3,
): Promise<DocsSearchResult[]> {
  const conn = await connect(indexDir);
  const queryVec = await embedSingle(query, config);

  let table: lancedb.Table;
  try {
    table = await conn.openTable(DOCS_TABLE);
  } catch {
    return [];
  }

  const results = await table.search(queryVec).limit(k).toArray();

  return results.map((r: any) => ({
    file: r.file_path,
    section: r.section,
    chunk: r.chunk_text,
    score: r._distance != null ? 1 / (1 + r._distance) : 0,
  }));
}

export async function searchMemory(
  query: string,
  config: EmbeddingProviderConfig,
  indexDir: string,
  k: number = 3,
  typeFilter?: string,
): Promise<MemorySearchResult[]> {
  const conn = await connect(indexDir);
  const queryVec = await embedSingle(query, config);

  let table: lancedb.Table;
  try {
    table = await conn.openTable(MEMORY_TABLE);
  } catch {
    return [];
  }

  const limit = typeFilter ? k * 3 : k;
  const results = await table.search(queryVec).limit(limit).toArray();

  let filtered = results;
  if (typeFilter) {
    filtered = results.filter((r: any) => r.type === typeFilter);
    filtered = filtered.slice(0, k);
  }

  return filtered.map((r: any) => ({
    file: r.file_path,
    name: r.name,
    type: r.type,
    chunk: r.chunk_text,
    score: r._distance != null ? 1 / (1 + r._distance) : 0,
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

async function getExistingHashes(
  conn: lancedb.Connection,
  tableName: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const table = await conn.openTable(tableName);
    const rows = await table.query().select(['file_path', 'content_hash']).toArray();
    for (const row of rows) {
      map.set((row as any).file_path, (row as any).content_hash);
    }
  } catch {
    // Table doesn't exist yet
  }
  return map;
}

async function upsertRows(
  conn: lancedb.Connection,
  tableName: string,
  rows: any[],
): Promise<void> {
  try {
    const table = await conn.openTable(tableName);
    const filePaths = [...new Set(rows.map((r) => r.file_path))];
    for (const fp of filePaths) {
      await table.delete(`file_path = '${fp.replace(/'/g, "''")}'`);
    }
    await table.add(rows);
  } catch {
    await conn.createTable(tableName, rows);
  }
}
