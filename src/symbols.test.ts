// symbols.test.ts — unit tests for the TypeScript symbol extractor.
//
// Pure: drives TypeScriptExtractor.extract directly against fixture files on
// disk (a real ts.Program is built from them). No db, no embedder, no network.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptExtractor } from './symbols.js';
import type { SymbolEdge, SymbolNode } from './types.js';

describe('TypeScriptExtractor — symbol nodes + resolved edges', () => {
  let projectRoot: string;
  let nodes: SymbolNode[];
  let edges: SymbolEdge[];

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rc-symbols-'));

    writeFileSync(
      join(projectRoot, 'base.ts'),
      `export function helper(x: number): number { return x + 1; }
export class Animal { speak(): string { return 'noise'; } }
export interface Named { name: string; }
`,
    );
    writeFileSync(
      join(projectRoot, 'consumer.ts'),
      `import { helper, Animal, Named } from './base';

export class Dog extends Animal implements Named {
  name = 'dog';
  bark(): number { return helper(3); }
}

export function run(n: Named): void {
  const d = new Dog();
  void d.bark();
  void n.name;
}
`,
    );

    const out = new TypeScriptExtractor().extract(['base.ts', 'consumer.ts'], projectRoot);
    nodes = out.nodes;
    edges = out.edges;
  });

  afterAll(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  const hasNode = (id: string, kind?: SymbolNode['kind']) =>
    nodes.some((n) => n.id === id && (kind ? n.kind === kind : true));
  const hasEdge = (src: string, dst: string, kind: SymbolEdge['kind']) =>
    edges.some((e) => e.src === src && e.dst === dst && e.kind === kind);

  test('collects top-level declarations and class methods as nodes', () => {
    expect(hasNode('base.ts::helper', 'function')).toBe(true);
    expect(hasNode('base.ts::Animal', 'class')).toBe(true);
    expect(hasNode('base.ts::Animal.speak', 'method')).toBe(true);
    expect(hasNode('base.ts::Named', 'interface')).toBe(true);
    expect(hasNode('consumer.ts::Dog', 'class')).toBe(true);
    expect(hasNode('consumer.ts::Dog.bark', 'method')).toBe(true);
    expect(hasNode('consumer.ts::run', 'function')).toBe(true);
  });

  test('resolves extends / implements heritage edges across files', () => {
    expect(hasEdge('consumer.ts::Dog', 'base.ts::Animal', 'extends')).toBe(true);
    expect(hasEdge('consumer.ts::Dog', 'base.ts::Named', 'implements')).toBe(true);
  });

  test('resolves a cross-file call to the innermost owning method', () => {
    // bark() calls the imported helper — attributed to the method, not the class.
    expect(hasEdge('consumer.ts::Dog.bark', 'base.ts::helper', 'calls')).toBe(true);
    // The call must NOT be misattributed to the enclosing class.
    expect(hasEdge('consumer.ts::Dog', 'base.ts::helper', 'calls')).toBe(false);
  });

  test('resolves a type used in a parameter position (uses-type)', () => {
    expect(hasEdge('consumer.ts::run', 'base.ts::Named', 'uses-type')).toBe(true);
  });

  test('does not emit self-edges or edges to unknown symbols', () => {
    expect(edges.every((e) => e.src !== e.dst)).toBe(true);
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges.every((e) => ids.has(e.src) && ids.has(e.dst))).toBe(true);
  });

  test('output is deterministically ordered', () => {
    const extractor = new TypeScriptExtractor();
    const a = extractor.extract(['base.ts', 'consumer.ts'], projectRoot);
    expect(a.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });
});
