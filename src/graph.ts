// graph.ts — Dependency graph extraction (AST imports + git co-changes)
//
// Builds a JSON graph of file relationships:
//   1. Import edges from TypeScript AST
//   2. Type/interface export tracking
//   3. Type consumer mapping (who imports which types)
//   4. Co-change pairs from git log

import ts from 'typescript';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { Glob } from 'bun';
import type { DependencyGraph, TypeExport, CoChangeEntry } from './types.js';

const GRAPH_FILE = 'graph.json';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildGraph(
  projectRoot: string,
  indexDir: string,
  codePatterns: string[],
  skipPatterns: string[],
  coChangeMinCount: number = 3,
  coChangeMaxCommits: number = 500,
): Promise<DependencyGraph> {
  console.error('[graph] Building dependency graph...');

  const files = await collectFiles(projectRoot, codePatterns, skipPatterns);
  console.error(`[graph] Analyzing ${files.length} files`);

  const imports: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};
  const namedImports: Record<string, string[]> = {};
  const typeExports: Record<string, TypeExport[]> = {};
  const typeConsumers: Record<string, string[]> = {};

  for (const filePath of files) {
    const absPath = resolve(projectRoot, filePath);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const result = analyzeFile(content, filePath, projectRoot);

    // Store type exports
    if (result.exports.length > 0) {
      typeExports[filePath] = result.exports;
    }

    // Store import edges
    if (result.importEdges.length > 0) {
      imports[filePath] = [];
      for (const edge of result.importEdges) {
        imports[filePath].push(edge.target);

        // Reverse edge
        if (!importedBy[edge.target]) importedBy[edge.target] = [];
        if (!importedBy[edge.target].includes(filePath)) {
          importedBy[edge.target].push(filePath);
        }

        // Named imports
        if (edge.names.length > 0) {
          const key = `${filePath}::${edge.target}`;
          namedImports[key] = edge.names;

          // Track type consumers
          for (const name of edge.names) {
            if (!typeConsumers[name]) typeConsumers[name] = [];
            if (!typeConsumers[name].includes(filePath)) {
              typeConsumers[name].push(filePath);
            }
          }
        }
      }
    }
  }

  // Mine co-changes from git
  const coChanges = mineCoChanges(projectRoot, coChangeMinCount, coChangeMaxCommits);
  console.error(`[graph] Found ${coChanges.length} co-change pairs`);

  const graph: DependencyGraph = {
    builtAt: new Date().toISOString(),
    imports,
    importedBy,
    namedImports,
    typeExports,
    typeConsumers,
    coChanges,
  };

  // Write to disk
  const graphPath = resolve(indexDir, GRAPH_FILE);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  console.error(`[graph] Graph written to ${graphPath}`);

  return graph;
}

export function loadGraph(indexDir: string): DependencyGraph | null {
  const graphPath = resolve(indexDir, GRAPH_FILE);
  if (!existsSync(graphPath)) return null;
  try {
    return JSON.parse(readFileSync(graphPath, 'utf-8')) as DependencyGraph;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query helpers (used by MCP tools)
// ---------------------------------------------------------------------------

export function queryDependencies(
  graph: DependencyGraph,
  filePath: string,
  direction: 'imports' | 'importedBy' | 'both' = 'both',
  depth: number = 1,
): { imports: string[]; importedBy: string[] } {
  const result = { imports: [] as string[], importedBy: [] as string[] };

  if (direction === 'imports' || direction === 'both') {
    result.imports = collectTransitive(graph.imports, filePath, depth);
  }
  if (direction === 'importedBy' || direction === 'both') {
    result.importedBy = collectTransitive(graph.importedBy, filePath, depth);
  }

  return result;
}

export function queryCoChanges(
  graph: DependencyGraph,
  filePath: string,
  minCount: number = 2,
): CoChangeEntry[] {
  return graph.coChanges
    .filter(
      (entry) =>
        (entry.fileA === filePath || entry.fileB === filePath) &&
        entry.count >= minCount,
    )
    .sort((a, b) => b.count - a.count);
}

export function queryTypeConsumers(
  graph: DependencyGraph,
  typeName: string,
): { definedIn: string[]; consumedBy: string[] } {
  const consumedBy = graph.typeConsumers[typeName] ?? [];
  const definedIn: string[] = [];

  for (const [file, exports] of Object.entries(graph.typeExports)) {
    if (exports.some((e) => e.name === typeName)) {
      definedIn.push(file);
    }
  }

  return { definedIn, consumedBy };
}

// ---------------------------------------------------------------------------
// AST analysis
// ---------------------------------------------------------------------------

interface FileAnalysis {
  exports: TypeExport[];
  importEdges: Array<{ target: string; names: string[] }>;
}

function analyzeFile(
  source: string,
  filePath: string,
  projectRoot: string,
): FileAnalysis {
  const exports: TypeExport[] = [];
  const importEdges: Array<{ target: string; names: string[] }> = [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  } catch {
    return { exports, importEdges };
  }

  ts.forEachChild(sourceFile, (node) => {
    // Collect imports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolved = resolveImport(specifier, filePath, projectRoot);
      if (resolved) {
        const names: string[] = [];
        if (node.importClause) {
          if (node.importClause.name) {
            names.push(node.importClause.name.text);
          }
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              names.push(el.name.text);
            }
          }
        }
        importEdges.push({ target: resolved, names });
      }
    }

    // Collect exports
    if (hasExportModifier(node)) {
      const name = getDeclarationName(node);
      if (name) {
        exports.push({ name, kind: getNodeKind(node), file: filePath });
      }
    }
  });

  return { exports, importEdges };
}

function resolveImport(specifier: string, fromFile: string, projectRoot: string): string | null {
  // Only resolve relative imports — skip node_modules
  if (!specifier.startsWith('.')) return null;

  const fromDir = dirname(fromFile);
  let resolved = resolve(projectRoot, fromDir, specifier);

  // Strip project root to get relative path
  const rel = relative(projectRoot, resolved);

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  for (const ext of extensions) {
    const candidate = rel + ext;
    if (existsSync(resolve(projectRoot, candidate))) {
      return candidate;
    }
  }

  // If the specifier already has an extension
  if (extname(rel) && existsSync(resolve(projectRoot, rel))) {
    return rel;
  }

  // Try without .js -> .ts mapping (common in ESM projects)
  if (rel.endsWith('.js')) {
    const tsPath = rel.replace(/\.js$/, '.ts');
    if (existsSync(resolve(projectRoot, tsPath))) return tsPath;
    const tsxPath = rel.replace(/\.js$/, '.tsx');
    if (existsSync(resolve(projectRoot, tsxPath))) return tsxPath;
  }

  return null;
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
    if (decl && ts.isIdentifier(decl.name)) return decl.name.text;
  }
  return null;
}

function getNodeKind(node: ts.Node): TypeExport['kind'] {
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isFunctionDeclaration(node)) return 'function';
  return 'variable';
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// ---------------------------------------------------------------------------
// Git co-change mining
// ---------------------------------------------------------------------------

function mineCoChanges(
  projectRoot: string,
  minCount: number,
  maxCommits: number,
): CoChangeEntry[] {
  let logOutput: string;
  try {
    logOutput = execSync(
      `git log --pretty=format:"---COMMIT---" --name-only -n ${maxCommits}`,
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    console.error('[graph] Git log failed, skipping co-change analysis');
    return [];
  }

  const commits = logOutput
    .split('---COMMIT---')
    .filter((c) => c.trim().length > 0)
    .map((c) =>
      c
        .trim()
        .split('\n')
        .filter((f) => f.trim().length > 0),
    );

  // Count co-occurrences
  const pairCounts = new Map<string, number>();

  for (const files of commits) {
    // Only consider commits with 2-20 files (skip merge commits / huge refactors)
    if (files.length < 2 || files.length > 20) continue;

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const pair = [files[i], files[j]].sort().join('::');
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }

  const results: CoChangeEntry[] = [];
  for (const [pair, count] of pairCounts) {
    if (count >= minCount) {
      const [fileA, fileB] = pair.split('::');
      results.push({ fileA, fileB, count });
    }
  }

  return results.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function collectFiles(
  projectRoot: string,
  codePatterns: string[],
  skipPatterns: string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of codePatterns) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan({ cwd: projectRoot, absolute: false, onlyFiles: true })) {
      if (skipPatterns.some((sp) => path.includes(sp))) continue;
      if (!files.includes(path)) files.push(path);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

function collectTransitive(
  adjacency: Record<string, string[]>,
  start: string,
  depth: number,
): string[] {
  const visited = new Set<string>();
  const queue: Array<{ node: string; level: number }> = [{ node: start, level: 0 }];

  while (queue.length > 0) {
    const { node, level } = queue.shift()!;
    if (level > 0) visited.add(node);
    if (level >= depth) continue;

    const neighbors = adjacency[node] ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && neighbor !== start) {
        queue.push({ node: neighbor, level: level + 1 });
      }
    }
  }

  return [...visited];
}
