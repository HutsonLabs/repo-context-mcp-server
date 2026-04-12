// wiki.ts — LLM Wiki: Claude-maintained knowledge base
//
// Stores markdown pages in .repo-context/wiki/ with cross-links.
// Adapted from Andrej Karpathy's LLM Wiki pattern for codebase knowledge.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import type { WikiPage } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIKI_DIR = 'wiki';

const INDEX_TEMPLATE = `# Wiki Index

This wiki is maintained by Claude Code to capture architectural decisions,
known pitfalls, and tribal knowledge that can't be derived from the code alone.

## Pages

*No pages yet. Claude will add pages as it learns about the codebase.*
`;

const LOG_TEMPLATE = `# Wiki Log

Append-only record of all wiki operations.

---
`;

const PAGE_TEMPLATE = (title: string, summary: string) => `# ${title}

**Summary**: ${summary}

**Last updated**: ${new Date().toISOString().split('T')[0]}

---

*Content to be added.*

## Related pages

*None yet.*
`;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initWiki(indexDir: string): string {
  const wikiDir = resolve(indexDir, WIKI_DIR);

  if (!existsSync(wikiDir)) {
    mkdirSync(wikiDir, { recursive: true });
    console.error(`[wiki] Created wiki directory at ${wikiDir}`);
  }

  const indexPath = resolve(wikiDir, 'index.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, INDEX_TEMPLATE);
    console.error('[wiki] Created index.md');
  }

  const logPath = resolve(wikiDir, 'log.md');
  if (!existsSync(logPath)) {
    writeFileSync(logPath, LOG_TEMPLATE);
    console.error('[wiki] Created log.md');
  }

  return wikiDir;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function readWikiPage(indexDir: string, pageName: string): WikiPage | null {
  const wikiDir = resolve(indexDir, WIKI_DIR);
  const fileName = normalizePageName(pageName);
  const filePath = resolve(wikiDir, fileName);

  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  return parseWikiPage(fileName, content);
}

export function writeWikiPage(
  indexDir: string,
  pageName: string,
  content: string,
): { created: boolean; path: string } {
  const wikiDir = resolve(indexDir, WIKI_DIR);
  if (!existsSync(wikiDir)) {
    mkdirSync(wikiDir, { recursive: true });
  }

  const fileName = normalizePageName(pageName);
  const filePath = resolve(wikiDir, fileName);
  const isNew = !existsSync(filePath);

  writeFileSync(filePath, content);

  // Append to log
  appendLog(indexDir, isNew ? 'created' : 'updated', fileName);

  return { created: isNew, path: filePath };
}

export function listWikiPages(indexDir: string): Array<{ name: string; summary: string; lastUpdated: string }> {
  const wikiDir = resolve(indexDir, WIKI_DIR);
  if (!existsSync(wikiDir)) return [];

  const files = readdirSync(wikiDir).filter(
    (f) => f.endsWith('.md') && f !== 'log.md',
  );

  return files.map((f) => {
    const content = readFileSync(resolve(wikiDir, f), 'utf-8');
    const page = parseWikiPage(f, content);
    return {
      name: f.replace(/\.md$/, ''),
      summary: page.summary,
      lastUpdated: page.lastUpdated,
    };
  });
}

// ---------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------

function parseWikiPage(fileName: string, content: string): WikiPage {
  const name = fileName.replace(/\.md$/, '');
  let summary = '';
  let lastUpdated = '';
  const relatedPages: string[] = [];

  for (const line of content.split('\n')) {
    const summaryMatch = line.match(/^\*\*Summary\*\*:\s*(.+)/);
    if (summaryMatch) summary = summaryMatch[1].trim();

    const dateMatch = line.match(/^\*\*Last updated\*\*:\s*(.+)/);
    if (dateMatch) lastUpdated = dateMatch[1].trim();

    // Extract [[wiki-links]]
    const linkMatches = line.matchAll(/\[\[([^\]]+)\]\]/g);
    for (const match of linkMatches) {
      const linked = match[1].trim();
      if (!relatedPages.includes(linked)) relatedPages.push(linked);
    }
  }

  return { name, content, summary, lastUpdated, relatedPages };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePageName(name: string): string {
  let normalized = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  if (!normalized.endsWith('.md')) normalized += '.md';
  return normalized;
}

function appendLog(indexDir: string, action: string, pageName: string): void {
  const logPath = resolve(indexDir, WIKI_DIR, 'log.md');
  if (!existsSync(logPath)) return;

  const date = new Date().toISOString().split('T')[0];
  const entry = `- **${date}**: ${action} \`${pageName}\`\n`;

  const existing = readFileSync(logPath, 'utf-8');
  writeFileSync(logPath, existing + entry);
}

/** Return the wiki directory path for use by indexers and watchers */
export function getWikiDir(indexDir: string): string {
  return resolve(indexDir, WIKI_DIR);
}
