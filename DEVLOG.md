# lucid-rag — Development Log

How this project was built, phase by phase: the decisions, the trade-offs, and
the bugs an adversarial review caught before they shipped. The [ROADMAP](./ROADMAP.md)
says *where we're going*; this log records *how we got here and what we learned*.

## Methodology

Every phase follows the same loop:

1. **Design against the contracts.** `packages/core` owns the interfaces
   (`EmbeddingProvider`, `GenerationProvider`, `Reranker`, `VectorStore`,
   `DocumentStore`, and the data model). Nothing depends on a concrete provider
   or database — implementations are injected.
2. **Implement the smallest coherent slice**, provider-agnostic and local-first.
3. **Verify at two levels:** `tsc --noEmit` (strict, `verbatimModuleSyntax`) plus
   unit tests. Integration tests that need Postgres **self-skip** when no
   database is reachable, so the suite is green with or without Docker.
4. **Adversarially review.** A multi-agent *find → verify* pass reads the actual
   code, each reviewer hunting a different failure class; a second, skeptical
   agent then tries to **refute** each finding before it counts. Only confirmed
   defects are fixed, and each fix lands with a regression test.
5. **Record status** in the ROADMAP and here.

The review step has repeatedly earned its keep — it finds the class of bug that
compiles, passes the happy-path tests, and only fails on real-world input or
under partial failure.

## Architecture

```
packages/core            provider- & DB-agnostic engine (zero runtime deps)
  types.ts               data model + RetrievalTrace
  providers.ts           EmbeddingProvider / GenerationProvider / Reranker
  vector-store.ts        VectorStore (retrieval) + DocumentStore (lifecycle)
  tokenize.ts chunk.ts   ingestion: token estimate + heading-aware chunker
  contextualize.ts       contextual retrieval (LLM situating blurb per chunk)
  ingest.ts              the ingestion pipeline

packages/store-postgres  Postgres + pgvector implementation of the store
```

---

## Phase 1.0 — Contracts

Scaffolded the monorepo (npm workspaces), `docker-compose` (Postgres +
pgvector), `.env.example`, and the `@lucid-rag/core` contracts. The centerpiece
is the multi-stage `RetrievalTrace` — the "see-through" record of dense
candidates, sparse candidates, the fused ranking, the rerank re-ordering, and
the near-misses. Interfaces were lifted from the `rag-glassbox` demo so concepts
stay consistent across both repos, and extended here with `Reranker`,
`VectorStore`, contextual chunks, and faithfulness.

## Phase 1.1 — Postgres + pgvector store

`@lucid-rag/store-postgres` implements `VectorStore`: dense (pgvector cosine),
sparse (Postgres full-text), and `jsonb` metadata filtering, all in one
database.

**Key decisions**

- **Dimensionless `embedding vector` column + exact KNN.** Each knowledge base
  pins its own embedding model/dimensions, and different KBs may differ. A fixed
  `vector(N)` column can't hold mixed dimensions, so the column is an
  unconstrained `vector` and dense search is *exact* KNN **scoped by
  `knowledge_base_id`** — correct at any dimension, and fast enough for a
  self-host starter. An ANN (HNSW) index is an optional per-dimension add-on.
- **Cascade-delete schema.** `knowledge_base → document → chunk` with
  `ON DELETE CASCADE`, so `deleteDocument` is a one-liner and re-ingest is clean.
- **Cosine similarity, not distance.** pgvector's `<=>` is cosine *distance*;
  the store returns `1 - (embedding <=> query)` so callers get a similarity.
- **Generated `tsv` for sparse.** A `GENERATED ALWAYS AS (...) STORED` tsvector
  (2-arg `to_tsvector`, which is immutable) keeps full-text in sync automatically.
- **Fully parameterized metadata filters.** Every key and value is a bound
  parameter — nothing is interpolated — so arbitrary metadata keys are safe.

**Review caught (1 confirmed):**

- 🐛 **Numeric-range filter could abort the whole query.**
  `(metadata->>key)::numeric >= $v` raises a *cast error* (not a row exclusion)
  when a filtered key holds a non-numeric value (an ISO-date string, `"n/a"`, a
  boolean) — killing the entire search, not just skipping the row. **Fix:** guard
  the cast with `CASE WHEN jsonb_typeof(metadata->key) = 'number' THEN … END`,
  which yields `NULL` (excluded) for non-numbers instead of throwing.

## Phase 1.2 — Ingestion pipeline

`ingestDocument`: **chunk → optional contextualize → embed → index.**

**Key decisions**

- **`DocumentStore` as a separate contract.** Retrieval (`VectorStore`) stays
  minimal; the KB/document lifecycle ingestion needs (create KB, upsert
  document) is its own interface. `PgVectorStore` implements both.
- **Heading-aware Markdown chunker** (`chunk.ts`): packs whole paragraphs up to a
  token budget, never crossing a heading boundary, tagging each chunk with its
  heading path, and splitting an over-long paragraph by sentences. It keeps
  **exact offsets** — `text.slice(charStart, charEnd) === chunk.text` — an
  invariant the tests assert on every chunk.
- **Contextual retrieval** (`contextualize.ts`): an LLM situating blurb per
  chunk (Anthropic's technique), prepended to the embed text. Bounded
  concurrency, and — after review — **fail-fast**.
- **All fallible work before any store mutation.** The pipeline chunks,
  contextualizes, embeds, and validates *first*, and only then deletes/creates
  the document and indexes chunks — so a transient failure can't leave a
  document empty.
- **KB pinned to the embedder; dimensions validated.** The KB records the
  embedder's model + dims, the pipeline refuses to re-ingest with a mismatched
  embedder, and every returned vector's length is checked before it's stored.

**Review caught (11 confirmed, 3 refuted).** A single find→verify pass over the
chunker, pipeline, and contextualizer found:

- 🐛 **Non-atomic replace = data loss.** Re-ingest deleted the old chunks
  *before* embedding; a transient embedder failure left the document with zero
  chunks. → Do all fallible work first; mutate the store last.
- 🐛 **Fenced code blocks parsed as headings.** A `# comment` line inside a
  ```` ``` ```` block was read as an ATX heading, corrupting section paths and
  splitting the code. → Track fence state; treat fenced content as opaque.
- 🐛 **Sibling sections with the same title merged.** Two `## Question` sections
  packed into one chunk (leaking `## ` markup into the body) because packing
  compared the section *string*. → Pack by a monotonic `sectionSeq`, not the title.
- 🐛 **Content silently dropped.** An over-long all-punctuation paragraph
  produced *zero* chunks, and leading `!!!`/`...` runs were shaved off. → Anchor
  sentence-splitting to `[0, len)` and always emit something.
- 🐛 **Setext headings ignored**, ATX **closing `##`** kept in the title, and
  **empty-title** headings yielding `''` instead of `undefined`.
- 🐛 **Embedding dimensions never validated** (only the vector *count* was).
- 🐛 **KB silently re-pinned** to a mismatched embedder → mixed dims in one KB.
- 🐛 **Abort signal ignored** on the default path.
- 🐛 **Worker pool didn't fail fast** — sibling lanes kept firing paid LLM calls
  after one call had already rejected. → Shared `AbortController`.

Refuted (correctly): the empty-doc `contextualized:false` flag (it reports an
outcome, not the request); `replace:false` "orphans" (that's the literal meaning
of opting out); and a "createKnowledgeBase isn't idempotent" claim (the real
store's `ON CONFLICT DO UPDATE` already is).

## Phase 1.3 — Hybrid retrieval + reranking

`retrieve(kbId, query, params, deps)` → `RetrievalTrace`. Dense and sparse
retrieval run concurrently; each signal is min-max normalized over its
candidates; they're fused (`keyword` / `semantic` / `hybrid`, blended by
`semanticWeight`); an optional cross-encoder reranker re-orders the fused
candidates; then the top-k and the near-misses below it are selected. Every
stage — dense, sparse, fused, reranked, near-misses, timings — is in the trace.

**Key decisions**

- **Min-max + weighted fusion.** Simple, order-preserving per signal, and keeps
  fused scores in `[0,1]`. Its known limitation — it discards absolute magnitude,
  so it can over-credit a lone/weak match — is exactly what the cross-encoder
  reranker exists to correct. Reciprocal Rank Fusion (RRF) is a candidate upgrade
  if score-scale robustness ever matters more than simplicity.
- **The reranker owns relevance; `retrieve` owns the cutoff.** No `topN` is passed
  to the reranker (it returns the full re-ordering); `retrieve` then takes `topK`
  and keeps the near-misses — so the glass-box near-miss panel still works with
  rerank on.
- **Concurrency + timings.** Dense (embed + vector search) and sparse (full-text)
  run in parallel, each timed into the trace.

**Review caught (2 confirmed, 6 refuted).**

- 🐛 **Normalization skewed by phantom candidates.** min-max ran over the full hit
  list, but hits `getChunks` couldn't hydrate were dropped from the output — so a
  dropped candidate still set the min/max and silently reordered the survivors.
  → Normalize over hydratable hits only.
- 🐛 **`trace.params` aliased the caller's object.** A parameter sweep that mutates
  one `params` object retroactively rewrote every prior trace's record.
  → Snapshot with `{ ...params }`.

Refuted (correctly): five variants of "min-max fusion over-weights lone/weak
matches" (a documented property of the chosen algorithm, corrected by the
reranker — not a bug) and two reranker cases that only trigger on
contract-violating input.

---

## Learnings (reusable across the project)

- **In SQL, a cast is a landmine.** `text::numeric` on bad data aborts the whole
  statement. Guard casts with `jsonb_typeof`/`CASE` so bad rows are *excluded*,
  not *fatal*. Never interpolate user data — bind every key and value.
- **Do all fallible work before any destructive mutation.** Networked steps
  (LLM, embeddings) fail transiently; if a delete precedes them, failure means
  data loss. Order: compute → validate → mutate.
- **Validate what you declare.** The KB "pins" the embedding dims, so the
  pipeline — the one place that holds both the dims and the vectors — must
  enforce it. Checking the count but not the dimension is an unprincipled half-measure.
- **Markdown is not line-oriented.** Fenced code blocks make `#`, blank lines,
  and `---` context-dependent. A real chunker needs fence state.
- **Preserve an invariant and test it directly.** `slice(charStart,charEnd) ===
  text` is asserted on every chunk in every chunker test — it's how offset bugs
  get caught cheaply.
- **Fail fast on paid, concurrent I/O.** A worker pool over an LLM API must stop
  dispatching once any call fails, or a single 500 becomes hundreds of wasted calls.
- **Identity, not equality.** Two things that render the same string (sibling
  section titles) aren't the same thing — track a structural id.
- **TypeScript control-flow gotcha:** a `let` mutated *only* inside a closure
  keeps its initializer's narrowed type in the outer scope. Assign it inline
  (or re-read via the declared type) so narrowing stays correct.
- **The adversarial verify step matters — and a "documented tradeoff" is not a
  bug.** Across the phase reviews a large share of raised findings were *refuted*
  on inspection. The clearest case: five separate reviewers flagged min-max
  fusion for over-crediting weak/lone matches — but that's an inherent, documented
  property of the algorithm (the reranker is the intended relevance corrector),
  not a defect. A plain "reviewer found X" list would have triggered an
  unnecessary fusion-algorithm rewrite. Making a skeptic try to *refute* each
  finding — and separating a real bug from a design tradeoff — is what keeps the
  signal high.

## Status

| Phase | Status |
|---|---|
| 1.0 Contracts | ✅ |
| 1.1 Postgres + pgvector store | ✅ |
| 1.2 Ingestion pipeline | ✅ |
| 1.3 Hybrid retrieval + reranking | ✅ |
| 1.4 Grounded generation | 🔧 next |
| 1.5 Evaluation harness | ⬜ |
| 1.6 Web app + self-host | ⬜ |

See the [ROADMAP](./ROADMAP.md) for Phases 2 (agentic) and 3 (enterprise).
