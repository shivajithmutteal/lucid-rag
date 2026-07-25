# Phase 1.4 — Grounded Generation (design)

Status: in progress. This doc records the plan and the *reasoning* behind each
decision before/while it's built; the [DEVLOG](../DEVLOG.md) records the outcome.

## Goal

Turn retrieved context into an answer that is **grounded** (only uses the
sources), **cited** (every claim points back to a source), **honest** (says "I
don't know" rather than inventing), and **provider-agnostic + streaming**. The
whole thing stays see-through: the exact prompt and the faithfulness verdict are
part of the returned `Answer`.

## Pipeline

```
RetrievalTrace ─▶ build grounded prompt (numbered sources)
              ─▶ generate (streaming, provider-agnostic)
              ─▶ extract [n] citations
              ─▶ [optional] faithfulness check (2nd LLM pass)
              ─▶ Answer { text, citations, prompt, trace, faithfulness? }
```

## Key decisions (with reasoning)

### 1. `answerQuestion` consumes a `RetrievalTrace`; it does **not** run retrieval
- **Why:** separation of concerns and composability. `retrieve()` (Phase 1.3)
  already owns retrieval and produces the trace; generation consumes it. The
  trace is the clean interface between the two halves, and it's exactly the
  glass-box artifact. A caller does `retrieve()` then `answerQuestion(trace)`.
- **Alternative rejected:** a single `ask()` that retrieves *and* answers. It
  couples the two, hides the trace, and makes "retrieval-only" harder. A thin
  `ask()` convenience can be added later without changing this contract.

### 2. Numbered sources + `[n]` inline citations
- **Why:** numbering is the simplest citation scheme an LLM reliably produces,
  and it's trivially machine-extractable. Sources are numbered `1..k` from
  `trace.results` (already ranked); the model cites `[1]`, `[2][3]`, etc.
- **Extraction** is deterministic parsing (`/\[([\d\s,]+)\]/`), not another LLM
  call — it handles `[1]`, `[1,2]`, `[1][2]`, ignores out-of-range numbers, and
  de-dupes. Each `[n]` maps to `sources[n-1]` → `Citation { n, chunkId,
  documentId, section }`.
- **Alternative rejected:** span-level / quote-based citations. Higher fidelity
  but far more brittle to produce and parse; `[n]`-per-claim is the Tier-A
  standard and enough for a trustworthy answer.

### 3. Faithfulness is an **optional** second LLM pass, fail-closed on ambiguity
- **Why optional:** it doubles the LLM cost and latency. Callers opt in via
  `checkFaithfulness: true`. The checker defaults to the same generator but can
  be a cheaper/separate model (`deps.faithfulnessChecker`).
- **How:** the checker is asked to decompose the answer into atomic claims and
  mark each supported/unsupported by the sources, returning strict JSON. We parse
  it, `score = supported / total`, `supported = score >= threshold` (default 0.8,
  tunable), and surface the unsupported claims.
- **Fail-closed:** if the checker's output can't be parsed, we return
  `score 0 / supported false` rather than assuming the answer is fine — a
  faithfulness check that silently passes on failure is worse than useless.
- **Alternative rejected (for now):** embedding-based NLI/entailment scoring. No
  extra LLM call, but needs an entailment model and is less interpretable; the
  claim-list approach yields human-readable `unsupportedClaims`. Revisit in eval
  (Phase 1.5) where RAGAS-style metrics live.

### 4. Provider-agnostic streaming, "commit on first token" left to the provider
- **Why:** `GenerationProvider.generate` already takes `onToken`/`signal`. We
  pass them straight through and accumulate the returned full text, so any
  provider (Ollama, Claude, OpenAI, …) works unchanged. Failover/commit
  semantics live in the provider layer, not here.

### 5. No-sources short-circuit
- **Why:** if `trace.results` is empty, there's nothing to ground on. We return a
  deterministic "I don't know — no relevant sources" answer **without** an LLM
  call — saving cost and guaranteeing the honest outcome the system promises.

### 6. `Answer.prompt` stores the exact input (system + user)
- **Why:** the glass-box guarantee. The answer records precisely what was sent to
  the model, so a reviewer can reproduce and audit it.

## Interfaces (additions to `@lucid-rag/core`)

```ts
answerQuestion(trace, deps, options?): Promise<Answer>
  deps:    { generator: GenerationProvider; faithfulnessChecker?: GenerationProvider }
  options: { maxTokens?; checkFaithfulness?; faithfulnessThreshold?; onToken?; signal? }

buildAnswerPrompt(query, sources): string     // numbered-source prompt (exported for the glass box)
extractCitations(text, sources): Citation[]   // deterministic [n] parsing
checkFaithfulness(answer, sources, checker, opts?): Promise<FaithfulnessReport>
```

`Answer`, `Citation`, and `FaithfulnessReport` already exist in the data model
(Phase 1.0), so this phase fills them in rather than adding new types.

## Testing

All unit-testable with in-memory fakes (no network): prompt shape, citation
extraction across `[1]`/`[1,2]`/out-of-range/dedup, the no-sources short-circuit,
streaming (`onToken` fires), faithfulness scoring + threshold + fail-closed
parse. Then the same adversarial find→verify review as every other phase.

## Hardening decisions (from the adversarial review)

The find→verify review confirmed 5 defects and split on one. Decisions + reasoning:

- **Citations ignore code / index syntax.** `data[2]` or `` `arr[2]` `` was read as
  a citation to source 2. Fixed by stripping code spans and requiring a marker to
  be in *citation position* (a negative lookbehind for a word char), which still
  allows grouped `[1][2]`. **Residual, accepted:** a markdown reference-style link
  `[text][2]` is lexically identical to a valid grouped citation, so it can still
  yield a spurious `[2]` — deferred (see open questions).
- **Space-separated groups** (`[1 2]`) are split on whitespace-or-commas now, so
  they no longer silently drop every citation.
- **Faithfulness is fail-closed *per claim*.** The checker's claim list is never
  filtered for malformed entries — dropping one shrinks the denominator and can
  only *raise* the score, letting a mangled "unsupported" verdict pass. Every
  entry is kept; loose booleans are coerced; anything ambiguous counts as
  **unsupported**. This closed a genuine fail-OPEN hole in the safety guard.
- **JSON extraction is brace-balanced** (string/escape aware), not greedy
  first-`{`-to-last-`}`, so a trailing note or a second object after the verdict no
  longer throws away a valid, faithful result.
- **Abort is honored before the faithfulness call** (a second, billable LLM pass).

**Adjudicated split verdict — an empty claim list.** One reviewer said a parsed
`{"claims":[]}` (an answer that asserts nothing, e.g. an honest "I don't know")
should be *vacuously faithful*; another said keep it fail-closed. **Decision: a
successfully-parsed empty list is vacuously faithful (score 1); only *unparseable*
output fails closed.** Reasoning: a claimless answer cannot contradict the sources
(the RAGAS convention), we already trust the checker's per-claim verdicts so "no
claims" is no new fail-open surface, and this stops the flagship honest-refusal
from being scored as a total faithfulness failure.

## Open questions / future

- **Citation validation:** should we drop `[n]` the model emitted for a source it
  didn't actually use? Out of scope for 1.4 (we trust the marker); revisit if
  faithfulness flags over-citation.
- **Streaming the faithfulness result** and **partial-answer citation** are
  deferred.
- Entailment-based faithfulness is reconsidered in **Phase 1.5 (eval)**.
