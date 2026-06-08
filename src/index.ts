// index.ts — repo-context MCP server entry point (Streamable HTTP transport)
//
// Generic codebase context server. Exposes vector search (search_code,
// search_docs, search_memory), dependency-graph queries (query_dependencies,
// query_co_changes, query_type_consumers), wiki CRUD (search_wiki,
// read_wiki_page, write_wiki_page, list_wiki_pages), and the partition
// scheduler. Pointed at any repo via PROJECT_ROOT (and isolated by REPO_ID).
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
import type { RepoConfig, GraphConfig } from './types.js';

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

// Container / serving config (env-overridable). Connection + embedding model
// (and therefore the vector dimension) are shared by every repo.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/repo_context';
const httpPort = Number(process.env.PORT ?? 3000);

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

// ---------------------------------------------------------------------------
// Repo registry — one entry per served repository. A request selects a repo
// via the `X-Repo-Id` header (see the HTTP handler). When config.repos is
// absent we synthesize a single repo from PROJECT_ROOT / REPO_ID, preserving
// the original single-repo behavior; that synthesized repo is also the default
// when a request omits the header.
// ---------------------------------------------------------------------------

interface RepoCtx {
  repoId: string;
  projectRoot: string;
  memoryDir: string;
  indexDir: string;
  wikiDir: string;
  codePatterns: string[];
  docPatterns: string[];
  skipPatterns: string[];
  graphConfig: GraphConfig;
}

type IndexState = 'starting' | 'building' | 'ready';
const indexState = new Map<string, IndexState>();

function buildRepoRegistry(): Map<string, RepoCtx> {
  const serverCode = config.codePatterns ?? DEFAULT_CODE_PATTERNS;
  const serverDocs = config.docPatterns ?? DEFAULT_DOC_PATTERNS;
  const serverSkip = config.skipPatterns ?? DEFAULT_SKIP_PATTERNS;
  const serverGraph = config.graph ?? {};

  const defs: RepoConfig[] =
    config.repos && config.repos.length > 0
      ? config.repos
      : [
          {
            repoId: process.env.REPO_ID ?? 'default',
            projectRoot: process.env.PROJECT_ROOT ?? config.projectRoot ?? process.cwd(),
            memoryDir: config.memoryDir,
            codePatterns: config.codePatterns,
            docPatterns: config.docPatterns,
            skipPatterns: config.skipPatterns,
            graph: config.graph,
            wiki: config.wiki,
          },
        ];

  const registry = new Map<string, RepoCtx>();
  for (const def of defs) {
    if (!def.repoId) throw new Error('config.repos: every entry needs a repoId');
    if (!def.projectRoot) throw new Error(`config.repos[${def.repoId}]: projectRoot is required`);
    if (registry.has(def.repoId)) {
      throw new Error(`config.repos: duplicate repoId '${def.repoId}'`);
    }

    const indexDir = resolve(def.projectRoot, '.repo-context');
    if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });

    const wikiAutoInit = (def.wiki?.autoInit ?? config.wiki?.autoInit) !== false;
    const wikiDir = wikiAutoInit ? initWiki(indexDir) : getWikiDir(indexDir);

    const ctx: RepoCtx = {
      repoId: def.repoId,
      projectRoot: def.projectRoot,
      memoryDir: def.memoryDir ?? deriveMemoryDir(def.projectRoot),
      indexDir,
      wikiDir,
      codePatterns: def.codePatterns ?? serverCode,
      docPatterns: def.docPatterns ?? serverDocs,
      skipPatterns: def.skipPatterns ?? serverSkip,
      graphConfig: def.graph ?? serverGraph,
    };
    registry.set(ctx.repoId, ctx);
    indexState.set(ctx.repoId, 'starting');
    console.error(`[config] repo '${ctx.repoId}' -> ${ctx.projectRoot} (memory: ${ctx.memoryDir})`);
  }
  return registry;
}

const repos = buildRepoRegistry();
// The default repo when a request sends no X-Repo-Id: the sole repo if there is
// exactly one, otherwise undefined (header becomes mandatory).
const defaultRepoId = repos.size === 1 ? [...repos.keys()][0] : undefined;

// ---------------------------------------------------------------------------
// Initial index build (per repo)
// ---------------------------------------------------------------------------

async function buildIndex(repo: RepoCtx) {
  console.error(`[startup] Building index for '${repo.repoId}'...`);
  indexState.set(repo.repoId, 'building');
  const [codeCount, docsCount, memoryCount, wikiCount] = await Promise.all([
    indexCode(repo.projectRoot, repo.repoId, config.embedding, repo.codePatterns, repo.skipPatterns),
    indexDocs(repo.projectRoot, repo.repoId, config.embedding, repo.docPatterns),
    indexMemory(repo.memoryDir, repo.repoId, config.embedding),
    indexWiki(repo.wikiDir, repo.repoId, config.embedding),
  ]);

  // Build dependency graph (after code index since it uses same file patterns)
  const graph = await buildGraph(
    repo.projectRoot,
    repo.indexDir,
    repo.codePatterns,
    repo.skipPatterns,
    repo.graphConfig.coChangeMinCount ?? 3,
    repo.graphConfig.coChangeMaxCommits ?? 500,
  );

  const edgeCount = Object.values(graph.imports).reduce((sum, arr) => sum + arr.length, 0);
  indexState.set(repo.repoId, 'ready');
  console.error(
    `[startup] Index built for '${repo.repoId}': ${codeCount} code, ${docsCount} docs, ${memoryCount} memory, ${wikiCount} wiki chunks, ${edgeCount} import edges, ${graph.coChanges.length} co-change pairs`,
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

function createMcpServer(repo: RepoCtx): McpServer {
  const server = new McpServer({
    name: 'repo-context',
    version: '26.06.1',
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
      const results = await searchCode(query, config.embedding, repo.repoId, k, file_filter);
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
      const results = await searchDocs(query, config.embedding, repo.repoId, k);
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
      const results = await searchMemory(query, config.embedding, repo.repoId, k, type);
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
      const graph = loadGraph(repo.indexDir);
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
      const graph = loadGraph(repo.indexDir);
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
      const graph = loadGraph(repo.indexDir);
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
      const results = await searchWiki(query, config.embedding, repo.repoId, k);
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
      const page = readWikiPage(repo.indexDir, page_name);
      if (!page) {
        const pages = listWikiPages(repo.indexDir);
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
      const result = writeWikiPage(repo.indexDir, page_name, content);
      // Re-index wiki after write
      await indexWiki(repo.wikiDir, repo.repoId, config.embedding);
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
      const pages = listWikiPages(repo.indexDir);
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
        const graph = loadGraph(repo.indexDir);
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

// Resolve which repo a request targets. Primary selector is the `X-Repo-Id`
// header; a `/mcp/<repoId>` path segment is accepted as a fallback (handy for
// curl/debugging). With a single configured repo and no selector, that repo is
// the default; with several, the header becomes mandatory.
function resolveRepoId(req: Request, url: URL): string | undefined {
  const header = req.headers.get('x-repo-id');
  if (header && header.trim()) return header.trim();
  const m = url.pathname.match(/^\/mcp\/(.+)$/);
  if (m) return decodeURIComponent(m[1]);
  return defaultRepoId;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function main() {
  const dim = getDimensions(config.embedding);
  await initDb({ connectionString, dim });
  console.error(
    `[startup] Postgres ready (dim=${dim}, repos=${[...repos.keys()].join(', ')})`,
  );

  // Stateful Streamable HTTP: a new session creates its own transport+server,
  // bound to the repo resolved from the request's X-Repo-Id. Subsequent
  // requests are routed by the mcp-session-id header (repo binding sticks).
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    port: httpPort,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        const states = Object.fromEntries(indexState);
        const values = [...indexState.values()];
        const overall: IndexState = values.every((s) => s === 'ready')
          ? 'ready'
          : 'building';
        return jsonResponse({ status: 'ok', index: overall, repos: states });
      }
      if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) {
        return new Response('Not found', { status: 404 });
      }
      const sid = req.headers.get('mcp-session-id') ?? undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        const repoId = resolveRepoId(req, url);
        if (!repoId) {
          return jsonResponse(
            {
              error: 'missing X-Repo-Id: this server hosts multiple repos',
              available: [...repos.keys()],
            },
            400,
          );
        }
        const repo = repos.get(repoId);
        if (!repo) {
          return jsonResponse(
            { error: `unknown repo '${repoId}'`, available: [...repos.keys()] },
            404,
          );
        }
        let t: WebStandardStreamableHTTPServerTransport;
        t = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id: string) => { sessions.set(id, t); },
          onsessionclosed: (id: string) => { sessions.delete(id); },
        });
        const srv = createMcpServer(repo);
        await srv.connect(t);
        transport = t;
      }
      return transport.handleRequest(req);
    },
  });
  console.error(
    `[startup] MCP server (Streamable HTTP) listening on :${httpPort} (POST /mcp, select repo via X-Repo-Id header)`,
  );

  // Build + watch each repo. Sequential build avoids hammering the shared
  // embedder with every repo's chunks at once.
  for (const repo of repos.values()) {
    await buildIndex(repo);
    startWatcher({
      repoId: repo.repoId,
      projectRoot: repo.projectRoot,
      memoryDir: repo.memoryDir,
      wikiDir: repo.wikiDir,
      indexDir: repo.indexDir,
      embeddingConfig: config.embedding,
      codePatterns: repo.codePatterns,
      docPatterns: repo.docPatterns,
      skipPatterns: repo.skipPatterns,
      graphConfig: {
        coChangeMinCount: repo.graphConfig.coChangeMinCount ?? 3,
        coChangeMaxCommits: repo.graphConfig.coChangeMaxCommits ?? 500,
      },
    });
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
