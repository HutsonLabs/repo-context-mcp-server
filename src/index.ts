// index.ts — repo-context MCP server entry point (stdio transport)
//
// Generic codebase context server. Exposes three tools: search_code, search_docs, search_memory.
// Designed to be pointed at any repo via the MCP server's `cwd` config.
//
// Configuration resolution (first found wins):
//   1. <cwd>/repo-context.json
//   2. <cwd>/.repo-context/config.json
//   3. <server-dir>/config.json
//
// Memory directory auto-detection:
//   Derives from project path using Claude's convention:
//   ~/.claude/projects/<escaped-path>/memory/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from './embeddings.js';
import {
  indexCode,
  indexDocs,
  indexMemory,
  searchCode,
  searchDocs,
  searchMemory,
} from './lancedb.js';
import { startWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CODE_PATTERNS = ['**/*.{ts,tsx,js,jsx}'];
const DEFAULT_DOC_PATTERNS = ['docs/*.md', 'CLAUDE.md', '.claude/rules/*.md'];
const DEFAULT_SKIP_PATTERNS = [
  'node_modules', '.next', '/dist/', '/build/',
  '.bundle.', '.min.', '__tests__', '__mocks__',
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = loadConfig();
const projectRoot = config.projectRoot ?? process.cwd();
const codePatterns = config.codePatterns ?? DEFAULT_CODE_PATTERNS;
const docPatterns = config.docPatterns ?? DEFAULT_DOC_PATTERNS;
const skipPatterns = config.skipPatterns ?? DEFAULT_SKIP_PATTERNS;

// Auto-detect memory directory from project path
// Claude stores memory at ~/.claude/projects/<escaped-path>/memory/
// e.g., /Users/hutson/repos/myproject -> -Users-hutson-repos-myproject
function deriveMemoryDir(root: string): string {
  const escaped = root.replace(/\//g, '-');
  return resolve(
    process.env.HOME ?? '~',
    '.claude',
    'projects',
    escaped,
    'memory',
  );
}

const memoryDir = config.memoryDir ?? deriveMemoryDir(projectRoot);
const indexDir = resolve(projectRoot, '.repo-context');

if (!existsSync(indexDir)) {
  mkdirSync(indexDir, { recursive: true });
}

console.error(`[config] Project root: ${projectRoot}`);
console.error(`[config] Memory dir: ${memoryDir}`);
console.error(`[config] Index dir: ${indexDir}`);
console.error(`[config] Code patterns: ${codePatterns.join(', ')}`);
console.error(`[config] Doc patterns: ${docPatterns.join(', ')}`);

// ---------------------------------------------------------------------------
// Initial index build
// ---------------------------------------------------------------------------

async function buildIndex() {
  console.error('[startup] Building index...');
  const [codeCount, docsCount, memoryCount] = await Promise.all([
    indexCode(projectRoot, indexDir, config.embedding, codePatterns, skipPatterns),
    indexDocs(projectRoot, indexDir, config.embedding, docPatterns),
    indexMemory(memoryDir, indexDir, config.embedding),
  ]);
  console.error(
    `[startup] Index built: ${codeCount} code, ${docsCount} docs, ${memoryCount} memory chunks`,
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'repo-context',
  version: '1.0.0',
});

server.tool(
  'search_code',
  'Search codebase for implementations, patterns, and files. Returns relevant code chunks with file paths.',
  {
    query: z.string().describe('Natural language query or code pattern to search for'),
    k: z.number().min(1).max(20).default(5).describe('Number of results (default 5)'),
    file_filter: z
      .string()
      .optional()
      .describe('Glob pattern to filter files (e.g., "src/components/**")'),
  },
  async ({ query, k, file_filter }) => {
    try {
      const results = await searchCode(query, config.embedding, indexDir, k, file_filter);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching code found.' }] };
      }
      const text = results
        .map(
          (r, i) =>
            `### ${i + 1}. ${r.file}${r.exports ? ` (exports: ${r.exports})` : ''}\n\`\`\`\n${r.chunk}\n\`\`\``,
        )
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'search_docs',
  'Search project documentation for architecture, standards, and guidelines.',
  {
    query: z.string().describe('What to search for in docs'),
    k: z.number().min(1).max(10).default(3).describe('Number of results (default 3)'),
  },
  async ({ query, k }) => {
    try {
      const results = await searchDocs(query, config.embedding, indexDir, k);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching docs found.' }] };
      }
      const text = results
        .map((r, i) => `### ${i + 1}. ${r.file} > ${r.section}\n${r.chunk}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'search_memory',
  'Search past decisions, feedback, and project context from memory.',
  {
    query: z.string().describe('What to search for in memory'),
    k: z.number().min(1).max(10).default(3).describe('Number of results (default 3)'),
    type: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .optional()
      .describe('Filter by memory type'),
  },
  async ({ query, k, type }) => {
    try {
      const results = await searchMemory(query, config.embedding, indexDir, k, type);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching memory found.' }] };
      }
      const text = results
        .map((r, i) => `### ${i + 1}. ${r.name} (${r.type})\n${r.chunk}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await buildIndex();

  startWatcher({
    projectRoot,
    memoryDir,
    indexDir,
    embeddingConfig: config.embedding,
    codePatterns,
    docPatterns,
    skipPatterns,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[startup] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
