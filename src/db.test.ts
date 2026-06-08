// db.test.ts — integration tests for the bun:sqlite + sqlite-vec backend.
//
// Exercises the real dedup / upsert / prune / search lifecycle against a live
// local sqlite file. A self-contained fake embedding server stands in for
// Ollama/TEI, so the suite has no external service dependency — it only needs an
// extension-capable sqlite (Homebrew on macOS), which initDb arranges.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingProviderConfig } from './types.js';
import { getDimensions } from './embeddings.js';
import {
  initDb,
  closeDb,
  indexCode,
  searchCode,
  deleteFileFromTable,
} from './db.js';

const DIM = 768; // lmstudio default dim; matches fake embedder output

// Unique repo id so assertions never collide across runs.
const REPO_ID = `__db_test_${process.pid}`;

// ---------------------------------------------------------------------------
// Fake embedding server (LM Studio / OpenAI-compatible `/v1/embeddings`)
// ---------------------------------------------------------------------------

/** Deterministic unit-length vector derived from text — identical text => identical vector. */
function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = 1; // baseline so an (almost) empty string never produces a zero vector
  for (let i = 0; i < text.length; i++) {
    v[text.charCodeAt(i) % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let server: ReturnType<typeof Bun.serve> | null = null;
let config: EmbeddingProviderConfig;

// A separate read-only handle on the same db file for direct row-count
// assertions. Only touches the plain `chunks` table (no vec extension needed).
let probe: Database | null = null;
let dbPath = '';
let dbDir = '';

function countRows(source: string, filePath?: string): number {
  const sql = filePath
    ? `SELECT count(*) AS n FROM chunks WHERE repo_id = ? AND source = ? AND file_path = ?`
    : `SELECT count(*) AS n FROM chunks WHERE repo_id = ? AND source = ?`;
  const row = (
    filePath
      ? probe!.query(sql).get(REPO_ID, source, filePath)
      : probe!.query(sql).get(REPO_ID, source)
  ) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------

describe('db — bun:sqlite + sqlite-vec integration', () => {
  let projectRoot: string;

  beforeAll(async () => {
    // Fake embedder on an ephemeral port.
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string[] };
        const data = body.input.map((text, index) => ({ index, embedding: fakeVector(text) }));
        return Response.json({ data });
      },
    });

    config = {
      type: 'lmstudio',
      apiKey: null,
      baseUrl: `http://localhost:${server.port}`,
      model: 'fake-model',
    };
    expect(getDimensions(config)).toBe(DIM);

    dbDir = mkdtempSync(join(tmpdir(), 'rc-db-store-'));
    dbPath = join(dbDir, 'index.db');
    await initDb({ dbPath, dim: DIM });

    // Read handle opened after initDb so it inherits the extension-capable
    // sqlite. Plain (non-readonly) to avoid WAL/readonly snapshot quirks; the
    // suite only reads through it.
    probe = new Database(dbPath);

    projectRoot = mkdtempSync(join(tmpdir(), 'rc-db-test-'));
  });

  afterAll(() => {
    probe?.close();
    closeDb();
    server?.stop(true);
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  function writeProjectFile(rel: string, contents: string): void {
    const abs = join(projectRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }

  test('initDb records the embedding dimension', () => {
    const row = probe!.query(`SELECT value FROM meta WHERE key = 'dim'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe(String(DIM));
  });

  test('indexCode inserts chunks and reports a positive count', async () => {
    writeProjectFile('alpha.ts', `export function alpha() { return 'alpha'; }\n`);
    writeProjectFile('beta.ts', `export const beta = 42;\nexport function useBeta() { return beta; }\n`);

    const n = await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);
    expect(n).toBeGreaterThan(0);
    expect(countRows('code')).toBe(n);
    expect(countRows('code', 'alpha.ts')).toBeGreaterThan(0);
  });

  test('re-indexing unchanged files is a no-op (content-hash dedup)', async () => {
    const before = countRows('code');
    const n = await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);
    expect(n).toBe(0);
    expect(countRows('code')).toBe(before);
  });

  test('modifying a file replaces its chunks (upsert), not duplicates them', async () => {
    writeProjectFile('alpha.ts', `export function alpha() { return 'ALPHA-v2'; }\n`);

    const n = await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);
    expect(n).toBeGreaterThan(0);

    // Old content gone, new content present; beta.ts untouched.
    const results = await searchCode('alpha', config, REPO_ID, 20);
    const alphaChunks = results.filter((r) => r.file === 'alpha.ts');
    expect(alphaChunks.length).toBeGreaterThan(0);
    const text = alphaChunks.map((r) => r.chunk).join('\n');
    expect(text).toContain('ALPHA-v2');
    expect(text).not.toContain("'alpha'");
  });

  test('pruneDeletedFiles removes rows for files no longer on disk', async () => {
    expect(countRows('code', 'beta.ts')).toBeGreaterThan(0);

    rmSync(join(projectRoot, 'beta.ts'));
    await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);

    expect(countRows('code', 'beta.ts')).toBe(0);
    expect(countRows('code', 'alpha.ts')).toBeGreaterThan(0);
  });

  test('searchCode round-trips and respects the file_filter glob', async () => {
    writeProjectFile('sub/gamma.ts', `export function gamma() { return 'gamma'; }\n`);
    await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);

    const all = await searchCode('function', config, REPO_ID, 20);
    const files = new Set(all.map((r) => r.file));
    expect(files.has('sub/gamma.ts')).toBe(true);
    expect(files.has('alpha.ts')).toBe(true);

    const scoped = await searchCode('function', config, REPO_ID, 20, 'sub/**');
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => r.file.startsWith('sub/'))).toBe(true);
  });

  test('deleteFileFromTable removes a single file immediately', async () => {
    expect(countRows('code', 'sub/gamma.ts')).toBeGreaterThan(0);
    deleteFileFromTable(REPO_ID, 'code', 'sub/gamma.ts');
    expect(countRows('code', 'sub/gamma.ts')).toBe(0);
    // Sibling rows are untouched.
    expect(countRows('code', 'alpha.ts')).toBeGreaterThan(0);
  });

  test('all written rows are scoped to the configured repo_id', () => {
    const rows = probe!
      .query(`SELECT DISTINCT repo_id FROM chunks WHERE source = 'code' AND file_path = 'alpha.ts'`)
      .all() as Array<{ repo_id: string }>;
    expect(rows.map((r) => r.repo_id)).toContain(REPO_ID);
  });

  test('two repos sharing one db do not see each other\'s rows', async () => {
    const REPO_B = `${REPO_ID}_b`;
    const rootB = mkdtempSync(join(tmpdir(), 'rc-db-test-b-'));
    try {
      // Same relative filename in both repos, different contents.
      writeFileSync(join(projectRoot, 'shared.ts'), `export const fromA = 'AAA';\n`);
      writeFileSync(join(rootB, 'shared.ts'), `export const fromB = 'BBB';\n`);

      await indexCode(projectRoot, REPO_ID, config, ['**/*.ts'], ['node_modules']);
      await indexCode(rootB, REPO_B, config, ['**/*.ts'], ['node_modules']);

      // Each repo's search only surfaces its own content for the shared path.
      const fromA = (await searchCode('shared', config, REPO_ID, 20)).filter((r) => r.file === 'shared.ts');
      const fromB = (await searchCode('shared', config, REPO_B, 20)).filter((r) => r.file === 'shared.ts');

      expect(fromA.map((r) => r.chunk).join('\n')).toContain('AAA');
      expect(fromA.map((r) => r.chunk).join('\n')).not.toContain('BBB');
      expect(fromB.map((r) => r.chunk).join('\n')).toContain('BBB');
      expect(fromB.map((r) => r.chunk).join('\n')).not.toContain('AAA');

      // Pruning repo B leaves repo A's row for the same path intact.
      rmSync(join(rootB, 'shared.ts'));
      await indexCode(rootB, REPO_B, config, ['**/*.ts'], ['node_modules']);
      expect(countRows('code', 'shared.ts')).toBeGreaterThan(0); // A still present (countRows scopes to REPO_ID)
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
