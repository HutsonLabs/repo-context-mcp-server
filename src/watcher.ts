// watcher.ts — File watcher with debounced re-index

import { watch } from 'chokidar';
import type { EmbeddingProviderConfig } from './types.js';
import { indexCode, indexDocs, indexMemory, indexWiki, deleteFileFromTable } from './db.js';
import { buildGraph } from './graph.js';

const DEBOUNCE_MS = 5000;

interface WatcherConfig {
  projectRoot: string;
  memoryDir: string;
  wikiDir: string;
  indexDir: string;
  embeddingConfig: EmbeddingProviderConfig;
  codePatterns: string[];
  docPatterns: string[];
  skipPatterns: string[];
  graphConfig: {
    coChangeMinCount: number;
    coChangeMaxCommits: number;
  };
}

export function startWatcher(config: WatcherConfig): () => void {
  let codeTimer: ReturnType<typeof setTimeout> | null = null;
  let docsTimer: ReturnType<typeof setTimeout> | null = null;
  let memoryTimer: ReturnType<typeof setTimeout> | null = null;
  let wikiTimer: ReturnType<typeof setTimeout> | null = null;
  let isIndexing = false;

  const debounce = (
    existingTimer: ReturnType<typeof setTimeout> | null,
    fn: () => Promise<void>,
  ): ReturnType<typeof setTimeout> => {
    if (existingTimer) clearTimeout(existingTimer);
    return setTimeout(async () => {
      if (isIndexing) return;
      isIndexing = true;
      try {
        await fn();
      } catch (err) {
        console.error('[watcher] Re-index error:', err);
      } finally {
        isIndexing = false;
      }
    }, DEBOUNCE_MS);
  };

  const codeWatcher = watch(config.codePatterns, {
    cwd: config.projectRoot,
    ignored: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/__tests__/**',
      '**/__mocks__/**',
      '**/*.bundle.*',
      '**/*.min.*',
    ],
    persistent: true,
    ignoreInitial: true,
  });

  codeWatcher.on('unlink', async (path) => {
    // Fast path: reflect deletion immediately. A full re-index still runs via
    // the debounced 'all' handler, but that pruning happens after 5s+embedding.
    try {
      await deleteFileFromTable(config.indexDir, 'code', path);
    } catch (err) {
      console.error('[watcher] Immediate unlink failed for code:', err);
    }
  });
  codeWatcher.on('all', () => {
    codeTimer = debounce(codeTimer, async () => {
      await indexCode(config.projectRoot, config.indexDir, config.embeddingConfig, config.codePatterns, config.skipPatterns);
      // Rebuild graph when code changes
      await buildGraph(
        config.projectRoot,
        config.indexDir,
        config.codePatterns,
        config.skipPatterns,
        config.graphConfig.coChangeMinCount,
        config.graphConfig.coChangeMaxCommits,
      );
    });
  });

  const docsWatcher = watch(config.docPatterns, {
    cwd: config.projectRoot,
    persistent: true,
    ignoreInitial: true,
  });

  docsWatcher.on('unlink', async (path) => {
    try {
      await deleteFileFromTable(config.indexDir, 'docs', path);
    } catch (err) {
      console.error('[watcher] Immediate unlink failed for docs:', err);
    }
  });
  docsWatcher.on('all', () => {
    docsTimer = debounce(docsTimer, async () => {
      await indexDocs(config.projectRoot, config.indexDir, config.embeddingConfig, config.docPatterns);
    });
  });

  const memoryWatcher = watch('*.md', {
    cwd: config.memoryDir,
    ignored: ['MEMORY.md', 'archive/**'],
    persistent: true,
    ignoreInitial: true,
  });

  memoryWatcher.on('unlink', async (path) => {
    try {
      // Memory table keys by bare filename, not path
      await deleteFileFromTable(config.indexDir, 'memory', path);
    } catch (err) {
      console.error('[watcher] Immediate unlink failed for memory:', err);
    }
  });
  memoryWatcher.on('all', () => {
    memoryTimer = debounce(memoryTimer, async () => {
      await indexMemory(config.memoryDir, config.indexDir, config.embeddingConfig);
    });
  });

  const wikiWatcher = watch('*.md', {
    cwd: config.wikiDir,
    persistent: true,
    ignoreInitial: true,
  });

  wikiWatcher.on('unlink', async (path) => {
    try {
      await deleteFileFromTable(config.indexDir, 'wiki', path);
    } catch (err) {
      console.error('[watcher] Immediate unlink failed for wiki:', err);
    }
  });
  wikiWatcher.on('all', () => {
    wikiTimer = debounce(wikiTimer, async () => {
      await indexWiki(config.wikiDir, config.indexDir, config.embeddingConfig);
    });
  });

  console.error('[watcher] Watching for changes...');

  return () => {
    if (codeTimer) clearTimeout(codeTimer);
    if (docsTimer) clearTimeout(docsTimer);
    if (memoryTimer) clearTimeout(memoryTimer);
    if (wikiTimer) clearTimeout(wikiTimer);
    codeWatcher.close();
    docsWatcher.close();
    memoryWatcher.close();
    wikiWatcher.close();
  };
}
