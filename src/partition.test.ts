// partition.test.ts — pure unit tests for the file-level conflict gate and
// parallel-wave scheduler. No external services required.

import { describe, test, expect } from 'bun:test';
import { partition, type TouchSet } from './partition.js';
import type { DependencyGraph, CoChangeEntry } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal DependencyGraph carrying only the fields partition reads. */
function graphWith(coChanges: CoChangeEntry[] = [], headSha?: string): DependencyGraph {
  return {
    builtAt: '2024-01-01T00:00:00.000Z',
    imports: {},
    importedBy: {},
    namedImports: {},
    typeExports: {},
    typeConsumers: {},
    symbolConsumers: {},
    coChanges,
    headSha,
  };
}

/** Conflict edges as a normalized, order-independent set of "a|b" keys. */
function edgeKeys(result: ReturnType<typeof partition>): Set<string> {
  return new Set(
    result.conflictGraph.map((e) => {
      const a = String(e.a);
      const b = String(e.b);
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    }),
  );
}

// ---------------------------------------------------------------------------
// Conflict gate
// ---------------------------------------------------------------------------

describe('partition — conflict gate', () => {
  test('disjoint file sets produce no conflicts and a single wave', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['a.ts'] },
      { issue: 2, files: ['b.ts'] },
      { issue: 3, files: ['c.ts'] },
    ];
    const result = partition(sets, graphWith());

    expect(result.conflictGraph).toHaveLength(0);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]).toEqual([1, 2, 3]);
    expect(result.independentSet).toEqual([1, 2, 3]);
  });

  test('shared file creates a conflict and splits issues across waves', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['shared.ts', 'a.ts'] },
      { issue: 2, files: ['shared.ts', 'b.ts'] },
    ];
    const result = partition(sets, graphWith());

    expect(edgeKeys(result)).toEqual(new Set(['1|2']));
    expect(result.conflictGraph[0].reason).toBe('both touch shared.ts');
    // Greedy coloring in ascending issue order: 1 -> wave0, 2 -> wave1.
    expect(result.waves).toEqual([[1], [2]]);
    expect(result.independentSet).toEqual([1]);
  });

  test('conflict reason names the lexicographically smallest shared file', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['z.ts', 'm.ts', 'a.ts'] },
      { issue: 2, files: ['a.ts', 'm.ts', 'z.ts'] },
    ];
    const result = partition(sets, graphWith());
    expect(result.conflictGraph[0].reason).toBe('both touch a.ts');
  });

  test('non-overlapping issues in a 3-chain share a wave when independent', () => {
    // 1-2 conflict (x.ts), 2-3 conflict (y.ts), 1 and 3 are disjoint.
    const sets: TouchSet[] = [
      { issue: 1, files: ['x.ts'] },
      { issue: 2, files: ['x.ts', 'y.ts'] },
      { issue: 3, files: ['y.ts'] },
    ];
    const result = partition(sets, graphWith());

    expect(edgeKeys(result)).toEqual(new Set(['1|2', '2|3']));
    // 1 -> wave0, 2 -> wave1 (conflicts 1), 3 -> wave0 (only conflicts 2).
    expect(result.waves).toEqual([[1, 3], [2]]);
    expect(result.independentSet).toEqual([1, 3]);
  });

  test('whitespace around file paths is normalized before comparison', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: [' shared.ts'] },
      { issue: 2, files: ['shared.ts '] },
    ];
    const result = partition(sets, graphWith());
    expect(edgeKeys(result)).toEqual(new Set(['1|2']));
  });

  test('a fully-conflicting clique needs one wave per issue', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['core.ts'] },
      { issue: 2, files: ['core.ts'] },
      { issue: 3, files: ['core.ts'] },
    ];
    const result = partition(sets, graphWith());
    expect(result.conflictGraph).toHaveLength(3); // 1-2, 1-3, 2-3
    expect(result.waves).toEqual([[1], [2], [3]]);
  });

  test('empty input yields empty waves and an empty independent set', () => {
    const result = partition([], graphWith());
    expect(result.conflictGraph).toHaveLength(0);
    expect(result.waves).toHaveLength(0);
    expect(result.independentSet).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('partition — determinism', () => {
  test('input order does not affect the output', () => {
    const a: TouchSet[] = [
      { issue: 3, files: ['c.ts', 'shared.ts'] },
      { issue: 1, files: ['a.ts', 'shared.ts'] },
      { issue: 2, files: ['b.ts'] },
    ];
    const b: TouchSet[] = [a[1], a[2], a[0]]; // shuffled

    const ra = partition(a, graphWith());
    const rb = partition(b, graphWith());

    expect(ra.waves).toEqual(rb.waves);
    expect(ra.independentSet).toEqual(rb.independentSet);
    expect(edgeKeys(ra)).toEqual(edgeKeys(rb));
  });

  test('numeric issue ids are ordered numerically, not lexically', () => {
    const sets: TouchSet[] = [
      { issue: 10, files: ['a.ts'] },
      { issue: 2, files: ['b.ts'] },
    ];
    const result = partition(sets, graphWith());
    // Numeric ordering => 2 before 10 (lexical would put "10" first).
    expect(result.waves[0]).toEqual([2, 10]);
  });

  test('string issue ids are supported and ordered', () => {
    const sets: TouchSet[] = [
      { issue: 'ISSUE-b', files: ['x.ts', 's.ts'] },
      { issue: 'ISSUE-a', files: ['y.ts', 's.ts'] },
    ];
    const result = partition(sets, graphWith());
    expect(edgeKeys(result)).toEqual(new Set(['ISSUE-a|ISSUE-b']));
    expect(result.independentSet).toEqual(['ISSUE-a']);
  });
});

// ---------------------------------------------------------------------------
// Co-change overlay (advisory, NON-gating)
// ---------------------------------------------------------------------------

describe('partition — co-change advisory overlay', () => {
  test('surfaces a warning when two issues touch historically-coupled files', () => {
    // Issues touch DIFFERENT files (no conflict) that co-change in history.
    const sets: TouchSet[] = [
      { issue: 1, files: ['a.ts'] },
      { issue: 2, files: ['b.ts'] },
    ];
    const graph = graphWith([{ fileA: 'a.ts', fileB: 'b.ts', count: 5 }]);
    const result = partition(sets, graph, { coChangeMinCount: 3 });

    // No conflict — co-change is advisory only — so both stay in wave 0.
    expect(result.conflictGraph).toHaveLength(0);
    expect(result.independentSet).toEqual([1, 2]);

    expect(result.coChangeWarnings.length).toBeGreaterThan(0);
    const w = result.coChangeWarnings.find((x) => x.issue === 1);
    expect(w).toBeDefined();
    expect(w!.file).toBe('a.ts');
    expect(w!.coupledTo).toBe('b.ts');
    expect(w!.count).toBe(5);
  });

  test('co-change pairs below the threshold are ignored', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['a.ts'] },
      { issue: 2, files: ['b.ts'] },
    ];
    const graph = graphWith([{ fileA: 'a.ts', fileB: 'b.ts', count: 2 }]);
    const result = partition(sets, graph, { coChangeMinCount: 3 });
    expect(result.coChangeWarnings).toHaveLength(0);
  });

  test('no warning when both coupled files belong to the same issue', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['a.ts', 'b.ts'] },
      { issue: 2, files: ['c.ts'] },
    ];
    const graph = graphWith([{ fileA: 'a.ts', fileB: 'b.ts', count: 9 }]);
    const result = partition(sets, graph, { coChangeMinCount: 3 });
    expect(result.coChangeWarnings).toHaveLength(0);
  });

  test('co-change never adds a conflict edge or changes waves', () => {
    const sets: TouchSet[] = [
      { issue: 1, files: ['a.ts'] },
      { issue: 2, files: ['b.ts'] },
    ];
    const coupled = partition(
      sets,
      graphWith([{ fileA: 'a.ts', fileB: 'b.ts', count: 100 }]),
      { coChangeMinCount: 3 },
    );
    const plain = partition(sets, graphWith());
    expect(coupled.conflictGraph).toEqual(plain.conflictGraph);
    expect(coupled.waves).toEqual(plain.waves);
  });
});

// ---------------------------------------------------------------------------
// Result stamping
// ---------------------------------------------------------------------------

describe('partition — metadata', () => {
  test('passes through the graph HEAD sha', () => {
    const result = partition([{ issue: 1, files: ['a.ts'] }], graphWith([], 'abc123'));
    expect(result.headSha).toBe('abc123');
  });
});
