# Bug Ledger

Every defect the adversarial `find → verify` reviews (and the odd typecheck) have
caught and fixed, phase by phase — plus the notable **refuted** false-alarms,
because a review that only ever confirms isn't a review. Each fix landed with a
regression test. The narrative is in the [DEVLOG](../DEVLOG.md); this is the flat
reference.

## Tally

| Phase | Confirmed + fixed | Refuted / adjudicated |
|---|---|---|
| 1.1 pgvector store | 1 | 0 |
| 1.2 ingestion | 12 | 3 refuted |
| 1.3 retrieval + rerank | 2 | 6 refuted |
| 1.4 grounded generation | 5 | 5 refuted, 1 split→adjudicated |
| **Total** | **20** | **14 refuted, 1 adjudicated** |

The refuted count is the point: ~40% of raised findings were *not* real bugs.
Confirming them blindly would have meant rewriting correct code (see §Refuted).

---

## Phase 1.1 — Postgres + pgvector store

| ID | Sev | Issue | Fix |
|---|---|---|---|
| LR-01 | High | **Numeric-range filter cast error.** `(metadata->>key)::numeric >= $v` *aborts the whole query* when a filtered key holds a non-numeric value (an ISO-date string, `"n/a"`, a boolean) — not just excluding the row. | Guard the cast: `CASE WHEN jsonb_typeof(metadata->key)='number' THEN (…)::numeric END` — bad rows yield `NULL` (excluded) instead of throwing. |

## Phase 1.2 — Ingestion pipeline

| ID | Sev | Issue | Fix |
|---|---|---|---|
| LR-02 | High | **Non-atomic re-ingest = data loss.** Old chunks were deleted *before* embedding, so a transient embed failure left the document empty. | Do all fallible work (chunk → contextualize → embed → validate) *before* any destructive store mutation. |
| LR-03 | High | **Fenced code blocks parsed as headings.** A `# comment` line inside ```` ``` ```` corrupted section paths and split the code. | Track fence state; treat fenced content as opaque. |
| LR-04 | High | **Same-titled sibling sections merged** into one chunk, leaking `##` markup into the body (packing compared the section *string*). | Pack by a monotonic `sectionSeq`, not the title. |
| LR-05 | Med | **Content silently dropped.** An over-long all-punctuation paragraph produced *zero* chunks; leading `!!!`/`…` runs were shaved off. | Anchor sentence-splitting to `[0, len)`; always emit something. |
| LR-06 | Med | **Setext headings ignored** (`===`/`---` underlines) → section lost, underline indexed as text. | Detect a setext underline after a single buffered paragraph line. |
| LR-07 | Low | **ATX closing `##` kept in the title** (`## Leave ##` → "Leave ##"). | Strip a trailing ` #+` sequence. |
| LR-08 | Low | **Empty-title heading** (`# `) produced `section: ''` instead of `undefined`. | `filter(Boolean).join(' > ') || undefined`. |
| LR-09 | Med | **Embedding dimensions never validated** (only the vector *count* was) — a wrong-dim vector flowed into the store. | Assert every `embedding.length === embedder.dims` before writing. |
| LR-10 | Med | **KB silently re-pinned** to a mismatched embedder → mixed dims in one KB, breaking dense search. | Read the existing KB; refuse a model/dims mismatch. |
| LR-11 | Med | **Abort signal ignored** on the default (non-contextualize) path. | `throwIfAborted()` at entry, before delete, before embed. |
| LR-12 | Med | **Contextualizer didn't fail fast** — sibling lanes kept firing paid LLM calls after one had rejected. | Shared `AbortController`; stop dispatching once any call fails. |
| LR-13 | Build | **TS control-flow narrowing:** `buf`, mutated only inside a closure, kept its `null` initializer type → `never` on later use. *(Caught by `tsc`, not the review.)* | Assign `buf` inline in the loop, not via a closure. |

## Phase 1.3 — Hybrid retrieval + reranking

| ID | Sev | Issue | Fix |
|---|---|---|---|
| LR-14 | Med | **Normalization skewed by phantom candidates.** Min-max ran over the full hit list, but un-hydratable hits were dropped from output — so a dropped candidate set the min/max and silently reordered survivors. | Normalize over hydratable hits only. |
| LR-15 | Med | **`trace.params` stored by reference.** A parameter sweep reusing/mutating one `params` object retroactively corrupted every prior trace's record. | Snapshot with `{ ...params }`. |

## Phase 1.4 — Grounded generation

| ID | Sev | Issue | Fix |
|---|---|---|---|
| LR-16 | **High** | **Fail-OPEN in the faithfulness guard.** `parseClaimVerdicts` *dropped* malformed claim entries, shrinking the denominator so a mangled `"unsupported"` verdict *raised* the score — a partly-hallucinated answer could pass. | Keep every claim; coerce loose booleans; count anything ambiguous as **unsupported** (fail-closed *per claim*). |
| LR-17 | Med | **Greedy JSON match** (first `{` to last `}`) discarded a valid faithfulness verdict when the response had a trailing brace or second object. | Brace-balanced, string/escape-aware scan. |
| LR-18 | Med | **Code/index syntax mis-cited** — `data[2]` produced a citation to source 2. | Strip code spans; require citation position (negative lookbehind), still allowing `[1][2]`. |
| LR-19 | Low | **Space-separated group `[1 2]`** dropped every citation. | Split on `/[\s,]+/`. |
| LR-20 | Low | **No abort check** before the second, billable faithfulness LLM call. | `throwIfAborted()` before the checker call. |

**Adjudicated (LR-A1):** the reviewers *split* on an empty `{"claims":[]}` verdict
(one said fail-closed, one said vacuously faithful). Decision: a **successfully
parsed** empty claim list — an answer that asserts nothing, e.g. an honest "I
don't know" — is **vacuously faithful (score 1)**; only *unparseable* output fails
closed. Rationale: a claimless answer can't contradict the sources (RAGAS
convention), and we already trust the checker's per-claim verdicts.

---

## Refuted (the review working the other way)

These were raised and, on adversarial verification, found **not** to be defects —
each would have caused an unnecessary rewrite:

- **1.2 (3):** empty-doc `contextualized:false` (reports an outcome, not the
  request); `replace:false` "orphans" (the literal meaning of the opt-out flag);
  "createKnowledgeBase isn't idempotent" (the real store's `ON CONFLICT DO UPDATE`
  already is).
- **1.3 (6):** five variants of "min-max fusion over-weights lone/weak matches" —
  an inherent, documented property of the algorithm, corrected by the reranker,
  not a bug; and two reranker cases that only trigger on contract-violating input.
- **1.4 (5):** coercing a checker *exception* into a verdict (would fabricate a
  misleading `supported:false`); the "unsent prompt" on the no-sources path
  (distinguishable via the empty trace + empty Sources block); abort on the
  no-sources short-circuit; a fixed checker token budget; and "parse-failure
  indistinguishable from all-unsupported" (they differ — the latter has non-empty
  `unsupportedClaims`).

## Cross-cutting patterns

The confirmed bugs cluster into a few recurring shapes, distilled in the
DEVLOG's [Learnings](../DEVLOG.md#learnings-reusable-across-the-project):

- **Casts and drops are never neutral.** A SQL cast can abort a query (LR-01); a
  dropped scorer input shifts the score one way (LR-16). Fail toward the safe
  side; never let a malformed input silently vanish.
- **Do fallible work before destructive work** (LR-02) — networked steps fail.
- **Validate what you declare** — the KB pins the dims, so enforce them (LR-09/10).
- **Markdown/text isn't line-oriented** — fences and setext make context matter
  (LR-03/06), and answer text isn't pure prose (LR-17/18).
- **Identity, not equality** — same-string ≠ same-thing (LR-04).
