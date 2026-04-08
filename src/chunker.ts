// chunker.ts — AST-aware code chunking + markdown section splitting
//
// Code: Uses TypeScript compiler API to split at top-level declarations.
//       Falls back to sliding window for unparseable files.
// Docs: Splits on ## heading boundaries.
// Memory: Returns whole file as one chunk with parsed frontmatter.

import ts from 'typescript';
import { createHash } from 'node:crypto';

export interface Chunk {
  chunkIndex: number;
  chunkText: string;
  exports: string;
  imports: string;
  section: string;
}

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: string;
}

const MAX_CHUNK_CHARS = 6000;
const SLIDING_WINDOW_LINES = 200;
const SLIDING_OVERLAP_LINES = 50;

// ---------------------------------------------------------------------------
// Code chunking (TypeScript AST)
// ---------------------------------------------------------------------------

export function chunkCode(source: string, filePath: string): Chunk[] {
  // Only use AST parsing for TypeScript/JavaScript files
  if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath)) {
    try {
      return chunkCodeAST(source, filePath);
    } catch {
      return chunkCodeSlidingWindow(source);
    }
  }
  return chunkCodeSlidingWindow(source);
}

function chunkCodeAST(source: string, filePath: string): Chunk[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const chunks: Chunk[] = [];
  const lines = source.split('\n');

  const importPaths: string[] = [];
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      importPaths.push(node.moduleSpecifier.text);
    }
  });
  const importsStr = importPaths.join(', ');

  let currentChunkLines: string[] = [];
  let currentExports: string[] = [];
  let chunkIndex = 0;

  function flushChunk() {
    if (currentChunkLines.length === 0) return;
    const text = currentChunkLines.join('\n').trim();
    if (text.length > 0) {
      chunks.push({
        chunkIndex,
        chunkText: text.slice(0, MAX_CHUNK_CHARS),
        exports: currentExports.join(', '),
        imports: chunkIndex === 0 ? importsStr : '',
        section: '',
      });
      chunkIndex++;
    }
    currentChunkLines = [];
    currentExports = [];
  }

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) return;

    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const nodeLines = lines.slice(start.line, end.line + 1);
    const nodeText = nodeLines.join('\n');

    const name = getDeclarationName(node);
    const isExported = hasExportModifier(node);

    if (currentChunkLines.join('\n').length + nodeText.length > MAX_CHUNK_CHARS) {
      flushChunk();
    }

    currentChunkLines.push(...nodeLines);
    if (isExported && name) {
      currentExports.push(name);
    }
  });

  flushChunk();

  if (chunks.length === 0) {
    return chunkCodeSlidingWindow(source);
  }

  return chunks;
}

function getDeclarationName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text ?? null;
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function chunkCodeSlidingWindow(source: string): Chunk[] {
  const lines = source.split('\n');
  const chunks: Chunk[] = [];
  let i = 0;
  let chunkIndex = 0;

  while (i < lines.length) {
    const windowLines = lines.slice(i, i + SLIDING_WINDOW_LINES);
    const text = windowLines.join('\n').trim();
    if (text.length > 0) {
      chunks.push({
        chunkIndex,
        chunkText: text.slice(0, MAX_CHUNK_CHARS),
        exports: '',
        imports: '',
        section: '',
      });
      chunkIndex++;
    }
    i += SLIDING_WINDOW_LINES - SLIDING_OVERLAP_LINES;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Markdown chunking (split on ## headings)
// ---------------------------------------------------------------------------

export function chunkMarkdown(source: string): Chunk[] {
  const lines = source.split('\n');
  const chunks: Chunk[] = [];
  let currentSection = '(intro)';
  let currentLines: string[] = [];
  let chunkIndex = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        const text = currentLines.join('\n').trim();
        if (text.length > 0) {
          chunks.push({
            chunkIndex,
            chunkText: text.slice(0, MAX_CHUNK_CHARS),
            exports: '',
            imports: '',
            section: currentSection,
          });
          chunkIndex++;
        }
      }
      currentSection = headingMatch[1].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      chunks.push({
        chunkIndex,
        chunkText: text.slice(0, MAX_CHUNK_CHARS),
        exports: '',
        imports: '',
        section: currentSection,
      });
    }
  }

  if (chunks.length === 0 && source.trim().length > 0) {
    chunks.push({
      chunkIndex: 0,
      chunkText: source.trim().slice(0, MAX_CHUNK_CHARS),
      exports: '',
      imports: '',
      section: '(full file)',
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Memory chunking (whole file = one chunk)
// ---------------------------------------------------------------------------

export function chunkMemory(source: string): { chunk: Chunk; frontmatter: MemoryFrontmatter } {
  const fm: MemoryFrontmatter = { name: '', description: '', type: '' };
  let content = source;

  if (source.startsWith('---')) {
    const endIndex = source.indexOf('---', 3);
    if (endIndex !== -1) {
      const yaml = source.slice(3, endIndex);
      for (const line of yaml.split('\n')) {
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match) {
          const [, key, value] = match;
          if (key === 'name') fm.name = value.trim();
          if (key === 'description') fm.description = value.trim();
          if (key === 'type') fm.type = value.trim();
        }
      }
      content = source.slice(endIndex + 3).trim();
    }
  }

  return {
    chunk: {
      chunkIndex: 0,
      chunkText: content.slice(0, MAX_CHUNK_CHARS),
      exports: '',
      imports: '',
      section: '',
    },
    frontmatter: fm,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
