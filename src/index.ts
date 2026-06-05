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
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { loadConfig, getDimensions } from './embeddings.js';
import {
  initDb,
  indexCode,
  indexDocs,
  indexMemory,
  indexWiki,
  searchCode,
  searchDocs,
  searchMemory,
  searchWiki,
} from './db.js';
import { partition, formatPartition, type TouchSet } from './partition.js';
import { startWatcher } from './watcher.js';
import {
  buildGraph,
  loadGraph,
  queryDependencies,
  queryCoChanges,
  queryTypeConsumers,
} from './graph.js';
import {
  initWiki,
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  getWikiDir,
} from './wiki.js';

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
const projectRoot = process.env.PROJECT_ROOT ?? config.projectRoot ?? process.cwd();
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
const graphConfig = config.graph ?? {};
const wikiConfig = config.wiki ?? {};

// Container / serving config (env-overridable)
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/repo_context';
const repoId = process.env.REPO_ID ?? 'default';
const httpPort = Number(process.env.PORT ?? 3000);
let indexState: 'starting' | 'building' | 'ready' = 'starting';

if (!existsSync(indexDir)) {
  mkdirSync(indexDir, { recursive: true });
}

// Initialize wiki directory
const wikiDir = (wikiConfig.autoInit !== false)
  ? initWiki(indexDir)
  : getWikiDir(indexDir);

console.error(`[config] Project root: ${projectRoot}`);
console.error(`[config] Memory dir: ${memoryDir}`);
console.error(`[config] Index dir: ${indexDir}`);
console.error(`[config] Wiki dir: ${wikiDir}`);
console.error(`[config] Code patterns: ${codePatterns.join(', ')}`);
console.error(`[config] Doc patterns: ${docPatterns.join(', ')}`);

// ---------------------------------------------------------------------------
// Initial index build
// ---------------------------------------------------------------------------

async function buildIndex() {
  console.error('[startup] Building index...');
  const [codeCount, docsCount, memoryCount, wikiCount] = await Promise.all([
    indexCode(projectRoot, indexDir, config.embedding, codePatterns, skipPatterns),
    indexDocs(projectRoot, indexDir, config.embedding, docPatterns),
    indexMemory(memoryDir, indexDir, config.embedding),
    indexWiki(wikiDir, indexDir, config.embedding),
  ]);

  // Build dependency graph (after code index since it uses same file patterns)
  const graph = await buildGraph(
    projectRoot,
    indexDir,
    codePatterns,
    skipPatterns,
    graphConfig.coChangeMinCount ?? 3,
    graphConfig.coChangeMaxCommits ?? 500,
  );

  const edgeCount = Object.values(graph.imports).reduce((sum, arr) => sum + arr.length, 0);
  console.error(
    `[startup] Index built: ${codeCount} code, ${docsCount} docs, ${memoryCount} memory, ${wikiCount} wiki chunks, ${edgeCount} import edges, ${graph.coChanges.length} co-change pairs`,
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'repo-context',
    version: '1.1.0',
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
// Graph tools
// ---------------------------------------------------------------------------

server.tool(
  'query_dependencies',
  'Find what a file imports and what imports it. Use to understand coupling before changing a file.',
  {
    file_path: z.string().describe('Relative file path from project root'),
    direction: z
      .enum(['imports', 'importedBy', 'both'])
      .default('both')
      .describe('Which direction to traverse (default: both)'),
    depth: z.number().min(1).max(5).default(1).describe('How many levels deep to traverse (default: 1)'),
  },
  async ({ file_path, direction, depth }) => {
    try {
      const graph = loadGraph(indexDir);
      if (!graph) {
        return { content: [{ type: 'text' as const, text: 'Dependency graph not built yet. It will be available after the next index build.' }] };
      }
      const result = queryDependencies(graph, file_path, direction, depth);
      const parts: string[] = [`## Dependencies for \`${file_path}\``];

      if (result.imports.length > 0) {
        parts.push(`\n### Imports (${result.imports.length})`);
        for (const f of result.imports) {
          const names = graph.namedImports[`${file_path}::${f}`];
          parts.push(`- \`${f}\`${names ? ` (${names.join(', ')})` : ''}`);
        }
      }

      if (result.importedBy.length > 0) {
        parts.push(`\n### Imported by (${result.importedBy.length})`);
        for (const f of result.importedBy) {
          const names = graph.namedImports[`${f}::${file_path}`];
          parts.push(`- \`${f}\`${names ? ` (${names.join(', ')})` : ''}`);
        }
      }

      if (result.imports.length === 0 && result.importedBy.length === 0) {
        parts.push('\nNo dependencies found for this file.');
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'query_co_changes',
  'Find files that frequently change together in git history. Use to discover implicit coupling not visible from imports.',
  {
    file_path: z.string().describe('Relative file path from project root'),
    min_count: z.number().min(1).default(2).describe('Minimum co-change count to include (default: 2)'),
  },
  async ({ file_path, min_count }) => {
    try {
      const graph = loadGraph(indexDir);
      if (!graph) {
        return { content: [{ type: 'text' as const, text: 'Dependency graph not built yet.' }] };
      }
      const entries = queryCoChanges(graph, file_path, min_count);
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: `No co-change pairs found for \`${file_path}\` (min count: ${min_count}).` }] };
      }

      const lines = [`## Co-change pairs for \`${file_path}\`\n`];
      for (const e of entries) {
        const other = e.fileA === file_path ? e.fileB : e.fileA;
        lines.push(`- \`${other}\` (${e.count} commits together)`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'query_type_consumers',
  'Find where a type, interface, or export is defined and which files consume it. Use before modifying a type to find all consumers.',
  {
    type_name: z.string().describe('Name of the type, interface, enum, or exported symbol'),
  },
  async ({ type_name }) => {
    try {
      const graph = loadGraph(indexDir);
      if (!graph) {
        return { content: [{ type: 'text' as const, text: 'Dependency graph not built yet.' }] };
      }
      const result = queryTypeConsumers(graph, type_name);

      const lines = [`## Type: \`${type_name}\`\n`];

      if (result.definedIn.length > 0) {
        lines.push('### Defined in');
        for (const f of result.definedIn) {
          const exp = graph.typeExports[f]?.find((e) => e.name === type_name);
          lines.push(`- \`${f}\` (${exp?.kind ?? 'unknown'})`);
        }
      } else {
        lines.push('### Defined in\n*Not found in indexed exports.*');
      }

      if (result.consumedBy.length > 0) {
        lines.push(`\n### Consumed by (${result.consumedBy.length} files)`);
        for (const f of result.consumedBy) {
          lines.push(`- \`${f}\``);
        }
      } else {
        lines.push('\n### Consumed by\n*No consumers found.*');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Wiki tools
// ---------------------------------------------------------------------------

server.tool(
  'search_wiki',
  'Semantic search across the project wiki — architectural decisions, known pitfalls, tribal knowledge.',
  {
    query: z.string().describe('What to search for in the wiki'),
    k: z.number().min(1).max(10).default(3).describe('Number of results (default 3)'),
  },
  async ({ query, k }) => {
    try {
      const results = await searchWiki(query, config.embedding, indexDir, k);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching wiki pages found.' }] };
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
  'read_wiki_page',
  'Read a specific wiki page by name.',
  {
    page_name: z.string().describe('Page name (e.g., "zustand-patterns" or "editor-architecture")'),
  },
  async ({ page_name }) => {
    try {
      const page = readWikiPage(indexDir, page_name);
      if (!page) {
        const pages = listWikiPages(indexDir);
        const available = pages.map((p) => `- ${p.name}`).join('\n') || '*No pages yet.*';
        return {
          content: [{
            type: 'text' as const,
            text: `Page "${page_name}" not found.\n\n### Available pages:\n${available}`,
          }],
        };
      }
      return { content: [{ type: 'text' as const, text: page.content }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'write_wiki_page',
  'Create or update a wiki page. Use to capture architectural decisions, known pitfalls, and tribal knowledge that cannot be derived from code alone. Follow the wiki page format with Summary, Last updated, and Related pages sections.',
  {
    page_name: z.string().describe('Page name in lowercase-with-hyphens (e.g., "editor-architecture")'),
    content: z.string().describe('Full markdown content of the page'),
  },
  async ({ page_name, content }) => {
    try {
      const result = writeWikiPage(indexDir, page_name, content);
      // Re-index wiki after write
      await indexWiki(wikiDir, indexDir, config.embedding);
      return {
        content: [{
          type: 'text' as const,
          text: `Wiki page "${page_name}" ${result.created ? 'created' : 'updated'} successfully.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_wiki_pages',
  'List all wiki pages with their summaries.',
  {},
  async () => {
    try {
      const pages = listWikiPages(indexDir);
      if (pages.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No wiki pages yet. Use write_wiki_page to create one.',
          }],
        };
      }
      const text = pages
        .map((p) => `- **${p.name}**: ${p.summary || '*No summary*'} (updated: ${p.lastUpdated || 'unknown'})`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `## Wiki Pages\n\n${text}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

  // -------------------------------------------------------------------------
  // Partition (issue #3): batch parallel-safety scheduler
  // -------------------------------------------------------------------------
  server.tool(
    'partition',
    'Given per-issue touch sets, compute a conflict graph and a deterministic wave schedule of which issues can run in parallel. File-level gate (two issues conflict iff their file sets intersect). Co-change pairs are surfaced as advisory hidden-coupling warnings only, never as gates.',
    {
      touch_sets: z
        .array(
          z.object({
            issue: z.union([z.string(), z.number()]).describe('Issue id'),
            files: z.array(z.string()).describe('Relative file paths the issue will touch'),
            symbols: z.array(z.string()).optional().describe('Optional symbol ids (file::name)'),
          }),
        )
        .describe('One entry per issue'),
      min_co_change: z
        .number()
        .min(1)
        .default(3)
        .describe('Minimum co-change count to surface a hidden-coupling warning (default 3)'),
    },
    async ({ touch_sets, min_co_change }) => {
      try {
        const graph = loadGraph(indexDir);
        if (!graph) {
          return { content: [{ type: 'text' as const, text: 'Dependency graph not built yet.' }] };
        }
        const result = partition(touch_sets as TouchSet[], graph, { coChangeMinCount: min_co_change });
        return { content: [{ type: 'text' as const, text: formatPartition(result) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await initDb({ connectionString, repoId, dim: getDimensions(config.embedding) });
  console.error(`[startup] Postgres ready (repo_id=${repoId}, dim=${getDimensions(config.embedding)})`);

  // Stateful Streamable HTTP: a new session creates its own transport+server;
  // subsequent requests are routed by the mcp-session-id header.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    port: httpPort,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', index: indexState }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname !== '/mcp') {
        return new Response('Not found', { status: 404 });
      }
      const sid = req.headers.get('mcp-session-id') ?? undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        let t: WebStandardStreamableHTTPServerTransport;
        t = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id: string) => { sessions.set(id, t); },
          onsessionclosed: (id: string) => { sessions.delete(id); },
        });
        const srv = createMcpServer();
        await srv.connect(t);
        transport = t;
      }
      return transport.handleRequest(req);
    },
  });
  console.error(`[startup] MCP server (Streamable HTTP) listening on :${httpPort} (POST /mcp)`);

  indexState = 'building';
  await buildIndex();
  indexState = 'ready';

  startWatcher({
    projectRoot,
    memoryDir,
    wikiDir,
    indexDir,
    embeddingConfig: config.embedding,
    codePatterns,
    docPatterns,
    skipPatterns,
    graphConfig: {
      coChangeMinCount: graphConfig.coChangeMinCount ?? 3,
      coChangeMaxCommits: graphConfig.coChangeMaxCommits ?? 500,
    },
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
