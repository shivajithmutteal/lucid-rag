# Phase 1.5 — Evaluation Harness (design)

Status: in progress. Plan + reasoning up front; the [DEVLOG](../DEVLOG.md) records
the outcome and the [Bug Ledger](./bug-ledger.md) the fixes.

## Goal

Make quality **measured, not vibed**. Given a set of eval samples and a way to
answer them, compute RAGAS-style metrics so a change to chunking, retrieval, or
the prompt can be judged by numbers, not vibes. Closes out Tier A.

## Metrics

| Metric | What it asks | Needs |
|---|---|---|
| **Context precision** | Of the *retrieved* chunks, how many are relevant — and are they ranked high? | `expectedChunkIds` labels |
| **Context recall** | Of the *relevant* chunks, how many were retrieved? | `expectedChunkIds` labels |
| **Faithfulness** | Is the answer grounded in the retrieved context? | an LLM checker (reused from 1.4) |
| **Answer relevance** | Does the answer actually address the question? | an embedder + a generator |

These are exactly the four fields already in `EvalScores` (Phase 1.0), so 1.5
fills them in rather than adding types.

## Key decisions (with reasoning)

### 1. Label-based context precision/recall are the deterministic core
- **Why:** with `expectedChunkIds` labels, precision and recall are pure set/rank
  math — reproducible, instant, and unit-testable **with no LLM**. That is the
  backbone of a trustworthy harness; a metric you can't reproduce isn't a metric.
- **Context precision = rank-aware average precision** (mean of precision@k at each
  relevant hit), not plain precision — it rewards putting relevant chunks *higher*,
  which is what retrieval quality actually means. This matches RAGAS.
- **Context recall = |retrieved ∩ expected| / |expected|** over the labels.
- **Alternative rejected (for the core):** RAGAS's LLM-judged context precision
  (no labels, an LLM rates each chunk's relevance). Noisy, costly, non-reproducible
  — deferred as an optional add-on for label-free datasets.

### 2. Reuse `checkFaithfulness` from Phase 1.4
- **Why:** the faithfulness metric *is* the Phase 1.4 check. If the `Answer` already
  carries a `faithfulness` report, use its score; otherwise compute it once with the
  provided generator. No duplicated logic, and the fail-closed guarantees carry over.

### 3. Answer relevance = the RAGAS round-trip
- **How:** generate *N* questions the answer would answer, embed them and the
  original question, and average the cosine similarity. A relevant answer yields
  questions close to the real one; an evasive/off-topic answer doesn't.
- **Why this shape:** it needs no ground-truth answer — only the question, the
  answer, an embedder, and a generator — so it works on unlabeled questions.
- Needs `deps.embedder` + `deps.generator`; skipped (metric simply omitted) if
  either is absent.

### 4. The harness takes a `produceAnswer(sample) => Answer` function
- **Why:** composability, same as `answerQuestion` consuming a trace. The caller
  wires `retrieve → answerQuestion` however they like (mode, rerank, contextualize);
  the harness only *scores* the resulting `Answer` (which carries its `trace`). This
  keeps the harness independent of retrieval/generation wiring and trivially mockable.

### 5. Every metric is optional; aggregate skips what's absent
- **Why:** a sample without `expectedChunkIds` still gets faithfulness/relevance; a
  run with no embedder still gets precision/recall. Each `EvalScores` field is set
  only when computable, and the aggregate is the **mean over the samples where the
  metric was actually computed** — never counting a missing metric as zero.

### 6. Sequential over samples
- **Why:** evals run offline and hit rate-limited LLMs; sequential is predictable and
  avoids hammering providers. Bounded concurrency is a later ergonomic add-on.

## Interfaces (additions to `@lucid-rag/core`)

```ts
// pure, LLM-free — unit tested directly
cosineSimilarity(a, b): number
contextPrecision(retrievedIds, expectedIds: Set<string>): number   // rank-aware AP
contextRecall(retrievedIds, expectedIds: Set<string>): number
answerRelevance(question, answerText, embedder, generator, n?, signal?): Promise<number>

evaluate(samples, produceAnswer, deps?, options?): Promise<EvalReport>
  deps:    { embedder?; generator? }
  options: { relevanceQuestions?; faithfulnessThreshold?; signal? }
  EvalReport { results: EvalResult[]; aggregate: EvalScores }
```

## Testing

All unit-testable with in-memory fakes: precision (rank sensitivity), recall,
cosine, answer-relevance (fake generator emits questions, fake embedder gives
deterministic vectors), and the harness end-to-end (fake `produceAnswer` returning
crafted `Answer`s → asserted per-sample scores + aggregate that skips absent
metrics). Then the same adversarial find→verify review.

## Hardening decisions (from the adversarial review)

3 confirmed, 6 refuted. Decisions + reasoning:

- **Faithfulness is scored even for source-less answers.** The compute branch was
  gated on `trace.results.length > 0`, so a confident hallucination with zero
  retrieved chunks got *no* faithfulness score — biasing the aggregate exactly on
  the highest-risk case. `checkFaithfulness` handles empty sources correctly
  (unsupported → ~0; honest refusal → 1), so the gate is dropped, and the computed
  report is surfaced on the result answer.
- **`answerRelevance` marker-stripping requires a trailing space.** `\s*` let the
  regex chop `3.` off "3.14 …" and `-` off "-5 …"; `\s+` strips only real list
  prefixes ("1. ", "- ") and leaves number-leading questions intact.
- **`faithfulnessThreshold` is now observable.** It only affects `report.supported`,
  which the harness had discarded — so the option was inert. The computed report
  (with its threshold-applied `supported`) now rides on `EvalResult.answer.faithfulness`.

Refuted (correctly): `contextPrecision` "double-counts duplicate ids" (the pipeline
dedups candidate ids at fusion, and average precision is defined over distinct
docs); `cosineSimilarity` "truncates mismatched vectors" (all vectors come from one
embedder call, so dims always match); and `relevanceQuestions: 0` (out-of-domain).

## Open questions / future

- **LLM-judged context precision** (no labels) as an optional metric.
- **Answer correctness** vs `groundTruth` (semantic + factual) — `EvalScores` has no
  field for it yet; would need a type addition.
- **Bounded concurrency** over samples.
