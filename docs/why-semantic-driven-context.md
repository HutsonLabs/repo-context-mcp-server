# Why semantic-driven context

> The thesis: a coding agent is only as good as the context it can *find* and
> *trust*. `repo-context-mcp-server` pairs **meaning-first retrieval** (vector
> search) with a **verified structural graph** (TypeScript AST + git history).
> Retrieval drives the agent to the right place by meaning; the graph proves what
> actually connects to it. That pairing builds a better context graph than the
> two things agents do by default — lexical `grep`/`glob` or pure-LLM
> recall-from-training — and a better-grounded context graph is what makes the
> agent reliable.

This page argues that claim from the ground up. It is opinionated on purpose.

---

## 1. How agents get context today, and why both defaults fail

A coding agent dropped into a repository has two native ways to build a mental
model of the code:

**Lexical search — `grep` / `glob`.** Fast, exact, and *string-shaped*. It finds
text, not meaning. It fails in both directions:

- **Misses (false negatives).** You search `auth` and miss the file that calls it
  `verifyCredentials`, the middleware named `gate`, the OAuth handler that never
  uses the literal word. The concept is there; the string isn't. The agent
  concludes the code doesn't exist and proceeds on a false premise.
- **Noise (false positives).** You search `User` and get hundreds of hits —
  comments, unrelated `UserAgent`, log strings, a different `User` type from
  another module. The agent has to read them all to tell signal from noise, or it
  guesses.

Lexical search has no notion of "related," only "matches this substring." A human
bridges that gap with experience. An agent, on a repo it has never seen, often
can't.

**Parametric recall — the model's own weights.** The model "remembers" plausible
patterns from training. This is where hallucination lives: a confidently
asserted function that doesn't exist, an import path that's almost right, an API
shape from a different version of the library. The model has no way to know its
recall is stale or wrong, because nothing in the loop checks it against *this*
repository.

Both defaults share one fatal property: **nothing verifies them against the
actual codebase.** The agent acts on strings or on memory, and discovers it was
wrong only when the build breaks — if it's lucky enough to build.

---

## 2. Two layers, two jobs: recall and proof

This server is built on the observation that finding context and trusting context
are *different problems* and want *different machinery*.

### The semantic layer — recall by meaning

Code and docs are chunked (AST-aware for source, heading-aware for markdown),
embedded, and stored in a vector index. A query is embedded the same way, and
nearest-neighbor search returns the chunks whose *meaning* is closest — regardless
of whether they share any words with the query.

This directly fixes lexical search's miss problem. "Where do we rate-limit
requests?" surfaces the throttle, the token-bucket, the middleware — even when
none of them contain the word "rate-limit." Embeddings encode that
`verifyCredentials`, `gate`, and `auth` live in the same conceptual
neighborhood. **The semantic layer is what lets the agent reach the right part
of the code from an imperfect description** — which is the only kind of
description it ever starts with.

What the semantic layer does *not* do is prove anything. It returns a ranked list
of "probably relevant." Ranking is not a guarantee. For that, you need the second
layer.

### The structural layer — proof by construction

The dependency graph is not embedded and not ranked. It is computed
deterministically, at two granularities:

- **File-level import edges** from the TypeScript AST — who imports whom, with the
  named symbols on each edge, relative paths resolved to real files.
- **Symbol-level structural edges** at class/function granularity — a real
  `ts.Program` + TypeChecker resolves `calls`, `extends`, `implements`, and
  `uses-type` between *declarations*, across files and through import aliases. This
  is a call/reference graph, not a name match: `query_symbol("file::initDb")`
  returns the functions it actually calls and the ones that actually call it.
- **Type and symbol consumers** — a reverse index from a type to every file that
  imports it, including qualified `defFile::name` keys so two same-named symbols
  from different files never get conflated.
- **Co-change pairs** from `git log` — files that historically move together,
  with merge commits and giant refactors filtered out.
- **A HEAD SHA stamp** — the exact commit the graph was built against, so any
  answer can be validated against the tree it describes.

These are not "probably." `query_type_consumers` returns *every* importer, and
`query_symbol` returns *every* resolved caller, because both were built by walking
*every* reference through the type checker. There are no false positives from
comments or string literals, and — within the analyzed file set — no false
negatives. **The structural layer is ground truth.**

There is also a deliberately *fuzzy* member of this family: an **advisory
semantic overlay**. For each symbol, the embedding index records its nearest
neighbors in other files as similarity edges. This is the one place embeddings
enter the graph — and it is labeled as advisory everywhere it surfaces, exactly
because it is a ranked guess and not a resolved fact. It earns its place the same
way co-change does: it catches *conceptual* siblings (two hand-rolled retry loops,
a duplicated validator) that share no import and no call edge. Treated as a hint,
it is valuable; treated as proof, it would be a lie — so the design never lets it
masquerade as one.

> **Why "semantic-driven" and not "structural-driven"?** Because the graph,
> however exact, is inert without a way in. A graph of ten thousand nodes is
> useless to an agent that doesn't know which node to start from. Meaning is the
> entry point: semantic retrieval picks the node, the graph supplies the verified
> edges. Meaning drives; structure proves. Neither half is sufficient alone, and
> the semantic half is what makes the structural half *reachable* — hence
> "semantic-driven."

---

## 3. Why the pairing builds a *better graph* than either alone

The "graph" an agent actually works from is its working model of the code: which
pieces exist, how they connect, what's safe to touch. The quality of that graph
determines the quality of every decision downstream. Compare how each approach
builds it:

| Approach | How it finds the entry point | How it maps connections | Failure mode |
|---|---|---|---|
| `grep`/`glob` only | Substring match — misses synonyms, drowns in noise | Re-grep for each suspected link; manual, lossy | Incomplete and unverified; agent over-reads or gives up |
| Pure-LLM recall | Guesses from training | Guesses from training | Confident hallucination; no contact with the real repo |
| **Semantic + structural graph** | **Vector recall by meaning — finds it even when names don't match** | **AST/git edges — complete and exact** | **Bounded: limited by the analyzed file set, not by guessing** |

The pairing is strictly better at *both* sub-tasks. Semantic recall beats
substring match and parametric guessing at finding the starting node. The
structural graph beats re-grepping and guessing at enumerating connections,
because it was built once, exhaustively, from the syntax tree and the commit
history.

And critically, the two layers cover each other's blind spots:

- **The graph catches the semantic layer's over-confidence.** Search ranked a
  file as "most relevant"? `query_type_consumers` tells you whether it actually
  imports the thing — turning a ranked hunch into a yes/no fact.
- **Co-change catches what static analysis can't.** A config file and the code it
  gates, a test and its fixture, a schema and its migration: coupled in reality,
  invisible to the import graph. Git history sees the coupling that the AST never
  will. (And because correlation isn't causation, co-change is exposed as an
  *advisory* signal — see §5.)
- **Semantic recall catches what the graph can't index.** Prose intent,
  rationale, "we do it this way because…" — none of that is an import edge. It
  lives in docs, memory, and the wiki, all of which are in the semantic layer.

The result is a context graph that is both *reachable* (you can always find your
way in by meaning) and *trustworthy* (the edges are real). That combination is
the thing neither default can produce.

---

## 4. Why a better context graph makes agents more reliable

Reliability problems in coding agents are, overwhelmingly, *context* problems
wearing different costumes:

**Hallucinated APIs become impossible to sustain.** When the agent can retrieve
the real signature and verify the real call sites, "invent a plausible function"
stops being the path of least resistance. The ground truth is one tool call away,
cheaper than guessing and then debugging the guess.

**Refactors stop being half-done.** The single most common silent failure is
changing a type and missing a consumer. `query_type_consumers` returns the
*complete* set, including disambiguated same-named symbols. "Did I get all of
them?" goes from a judgment call to a closed list. A refactor against a complete
consumer set either compiles or names exactly what's left.

**Blast radius is known before the edit, not after.** `query_dependencies` (with
transitive depth), `query_symbol` (exact callers of a function, not just importers
of its file), and `query_co_changes` together answer "what does touching this
break?" *before* the change — at the granularity of the actual declaration being
edited, not the whole file. The agent reasons about consequences instead of
discovering them in CI.

**Less wasted context, more thinking.** Every file an agent reads to *find* the
relevant code is context spent on navigation instead of on the problem. Semantic
retrieval lands on the right chunks directly, so the agent's limited attention
goes to reasoning about the change rather than to re-deriving the map of the
codebase on every task. Tighter, more relevant context is also less distracting
context — fewer chances to anchor on an irrelevant file.

**Decisions persist instead of repeating.** The wiki and memory layers mean
"why did we abandon approach X?" has an answer the agent can retrieve, so it
doesn't cheerfully re-propose X next week. Institutional knowledge becomes
queryable instead of evaporating between sessions.

**The recall→verify loop is itself a reliability discipline.** Search to find,
graph to confirm. An agent that internalizes that loop stops acting on the first
plausible thing it sees. It develops the habit of checking — and a checking habit
is most of what "reliable" means.

The throughline: an agent fails when it acts on context that is incomplete,
stale, or imagined. This server attacks all three — semantic retrieval fights
*incomplete*, the freshly-rebuilt structural graph fights *stale*, and grounding
every claim in real edges fights *imagined*.

---

## 5. Honest boundaries

The argument above is strong, not unlimited. Where the design deliberately holds
back:

- **Structural analysis is currently TypeScript/JavaScript-aware.** Both the
  file-level import graph and the symbol-level call/reference graph are resolved by
  the TypeScript type checker, so they are exact for TS/JS but blind to other
  languages. Extraction runs behind a `SymbolExtractor` registry; files outside
  the analyzed set are indexed by the semantic layer as text but have no verified
  edges. (Polyglot extractors for Python/Java/Go — likely SCIP-backed — are the
  planned extension; the registry is the seam where they plug in.)
- **The semantic overlay is similarity, not a relationship.** Embedding-nearest
  symbols are *conceptual* siblings, not a proven dependency — so, like co-change,
  the overlay is exposed as advisory: surfaced under a separate heading in
  `query_symbol`, never gating, never mixed into the resolved structural edges.
- **Co-change is correlation, not causation.** Two files moving together in git
  doesn't *prove* a dependency. That's exactly why co-change is exposed as an
  **advisory overlay** — in `query_co_changes` as a signal to investigate, and in
  `partition` as a non-gating warning that never alters the conflict graph or the
  wave schedule. It points a human at hidden coupling; it never silently enforces
  it.
- **Semantic search ranks; it does not decide.** A top result is the model's best
  guess at relevance, not a fact. The whole design assumes you follow recall with
  structural verification rather than trusting the ranking — which is why both
  layers ship together and why the [getting-started playbook](./getting-started.md#5-tool-playbook--what-to-reach-for-and-when)
  frames every workflow as recall-then-verify.
- **Freshness is bounded by the watcher.** The graph and vectors track the working
  tree via a debounced re-index, and the graph carries a HEAD SHA so staleness is
  *detectable* — but a result is only as current as the last completed build.

None of these undercut the thesis. They sharpen it: the value is precisely in
*separating* recall from proof, being honest about which layer is which, and
never letting a ranked guess or a historical correlation masquerade as a verified
fact.

---

## Further reading

- [Getting started](./getting-started.md) — install, connect, and the tool-by-tool
  recall-then-verify playbook.
- [Top-level README](../README.md) — full reference: every tool, config field,
  the transport, and the end-to-end data flow.
