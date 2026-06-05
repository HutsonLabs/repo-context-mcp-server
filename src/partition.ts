// partition.ts — File-level partition / conflict-gate for parallel issue work
//
// Given a set of "touch sets" (the files each issue plans to modify), this
// module computes:
//   1. A conflict graph (two issues conflict iff they touch a shared file)
//   2. Parallel-safe "waves" via greedy graph coloring
//   3. The independent set (wave 0) that can be worked simultaneously
//   4. Advisory co-change warnings (hidden coupling between issues) — these
//      are NON-gating and never affect the conflict graph or waves.
//
// All functions are pure and deterministic: same inputs => same output.

import type { DependencyGraph } from './types.js';

export interface TouchSet {
  issue: string | number;
  files: string[];
  symbols?: string[];
}

/** An undirected conflict between two issues. */
export interface ConflictEdge {
  a: string | number;
  b: string | number;
  /** Human-readable reason, e.g. "both touch src/db.ts" */
  reason: string;
}

/** Advisory: two issues touch files that historically change together. */
export interface CoChangeWarning {
  issue: string | number;
  file: string;
  coupledTo: string;
  count: number;
}

export interface PartitionResult {
  conflictGraph: ConflictEdge[];
  /** Color classes in order; waves[0] is the independent set. */
  waves: Array<Array<string | number>>;
  independentSet: Array<string | number>;
  headSha?: string;
  coChangeWarnings: CoChangeWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable comparator for issue identifiers. If both are numbers, compare
 * numerically; otherwise compare their string representations.
 */
function compareIssues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** Normalize a file path for set comparison (trim only — paths are repo-relative). */
function normalizeFile(file: string): string {
  return file.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function partition(
  touchSets: TouchSet[],
  graph: DependencyGraph,
  opts?: { coChangeMinCount?: number },
): PartitionResult {
  const coChangeMinCount = opts?.coChangeMinCount ?? 3;

  // Deterministic ordering: process issues in ascending order.
  const ordered = [...touchSets].sort((x, y) => compareIssues(x.issue, y.issue));

  // Precompute normalized file sets per issue.
  const fileSets = new Map<string, Set<string>>();
  for (const ts of ordered) {
    const set = new Set<string>();
    for (const f of ts.files) set.add(normalizeFile(f));
    fileSets.set(String(ts.issue), set);
  }

  // -------------------------------------------------------------------------
  // FILE-LEVEL GATE: conflict iff file sets intersect.
  // -------------------------------------------------------------------------
  const conflictGraph: ConflictEdge[] = [];
  // adjacency keyed by stringified issue id
  const neighbors = new Map<string, Set<string>>();
  for (const ts of ordered) neighbors.set(String(ts.issue), new Set<string>());

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      const setA = fileSets.get(String(a.issue))!;
      const setB = fileSets.get(String(b.issue))!;

      const shared: string[] = [];
      for (const f of setA) {
        if (setB.has(f)) shared.push(f);
      }
      if (shared.length === 0) continue;

      // Lexicographically-smallest shared file for determinism.
      shared.sort();
      const file = shared[0];

      conflictGraph.push({
        a: a.issue,
        b: b.issue,
        reason: `both touch ${file}`,
      });
      neighbors.get(String(a.issue))!.add(String(b.issue));
      neighbors.get(String(b.issue))!.add(String(a.issue));
    }
  }

  // -------------------------------------------------------------------------
  // WAVES via greedy graph coloring (ascending tie-break).
  // -------------------------------------------------------------------------
  const colorOf = new Map<string, number>();
  const waves: Array<Array<string | number>> = [];

  for (const ts of ordered) {
    const id = String(ts.issue);
    const neighborColors = new Set<number>();
    for (const n of neighbors.get(id)!) {
      const c = colorOf.get(n);
      if (c !== undefined) neighborColors.add(c);
    }
    // Lowest-indexed wave containing no conflict-neighbor.
    let color = 0;
    while (neighborColors.has(color)) color++;
    colorOf.set(id, color);
    if (!waves[color]) waves[color] = [];
    waves[color].push(ts.issue);
  }

  const independentSet = waves[0] ?? [];

  // -------------------------------------------------------------------------
  // CO-CHANGE OVERLAY (advisory, NON-gating).
  // -------------------------------------------------------------------------
  // Map normalized file -> issues that touch it (excluding the file's own issue).
  const fileToIssues = new Map<string, Array<string | number>>();
  for (const ts of ordered) {
    for (const f of fileSets.get(String(ts.issue))!) {
      if (!fileToIssues.has(f)) fileToIssues.set(f, []);
      fileToIssues.get(f)!.push(ts.issue);
    }
  }

  const coChangeWarnings: CoChangeWarning[] = [];
  const seen = new Set<string>();

  for (const ts of ordered) {
    const myFiles = fileSets.get(String(ts.issue))!;
    for (const file of [...myFiles].sort()) {
      for (const entry of graph.coChanges) {
        if (entry.count < coChangeMinCount) continue;
        let coupledTo: string | null = null;
        if (entry.fileA === file) coupledTo = entry.fileB;
        else if (entry.fileB === file) coupledTo = entry.fileA;
        if (coupledTo === null) continue;

        // Is the coupled file touched by a DIFFERENT issue?
        const owners = fileToIssues.get(normalizeFile(coupledTo)) ?? [];
        const otherIssue = owners.some(
          (o) => compareIssues(o, ts.issue) !== 0,
        );
        if (!otherIssue) continue;

        const key = `${String(ts.issue)}::${file}::${coupledTo}`;
        if (seen.has(key)) continue;
        seen.add(key);

        coChangeWarnings.push({
          issue: ts.issue,
          file,
          coupledTo,
          count: entry.count,
        });
      }
    }
  }

  return {
    conflictGraph,
    waves,
    independentSet,
    headSha: graph.headSha,
    coChangeWarnings,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPartition(result: PartitionResult): string {
  const lines: string[] = [];

  lines.push('# Partition');
  if (result.headSha) {
    lines.push('');
    lines.push(`HEAD: \`${result.headSha}\``);
  }

  lines.push('');
  lines.push('## Waves');
  if (result.waves.length === 0) {
    lines.push('_(no issues)_');
  } else {
    result.waves.forEach((wave, i) => {
      const label = i === 0 ? ' (independent set)' : '';
      const ids = wave.map((x) => String(x)).join(', ');
      lines.push(`- Wave ${i + 1}${label}: ${ids}`);
    });
  }

  lines.push('');
  lines.push('## Conflicts');
  if (result.conflictGraph.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const edge of result.conflictGraph) {
      lines.push(`- ${String(edge.a)} ↔ ${String(edge.b)}: ${edge.reason}`);
    }
  }

  if (result.coChangeWarnings.length > 0) {
    lines.push('');
    lines.push('## ⚠ Hidden coupling');
    lines.push('_Advisory only — these do not gate parallelization._');
    for (const w of result.coChangeWarnings) {
      lines.push(
        `- Issue ${String(w.issue)}: \`${w.file}\` historically co-changes with \`${w.coupledTo}\` (${w.count}×)`,
      );
    }
  }

  return lines.join('\n');
}
