# Next steps

Phase 1 (Foundation) is complete and deployable. This records what comes next —
the near-term backlog carried out of Phase 1, and the Phase 2 plan — so the
direction is written down before we build it. Same methodology as before: a
design doc per slice, adversarial find→verify review on the risky code, every fix
in the [Bug Ledger](./bug-ledger.md).

## Near-term backlog (deferred from Phase 1)

Small, additive items that make the shipped product rounder. None block Phase 2.

- **Anthropic generation adapter** — `/v1/messages` (different shape from the
  OpenAI-compat adapter), via the official SDK. Add a `resolveGenerator` branch +
  restore Anthropic to `.env.example`'s precedence.
- **Reranker adapters** — Cohere / Voyage `/rerank`, implementing the core
  `Reranker` interface, then wire the `rerank` toggle into the ask route + UI
  (`retrieve()` already supports it; only the adapter + wiring are missing).
- **Document parsing** — PDF / docx extraction for ingest (today it takes
  plaintext/Markdown). A parse step in front of the pipeline; keep it pluggable.
- **App-layer review** — with ultracode off, the routes + UI were verified by
  typecheck + build + handler tests + smoke, not a full adversarial pass. Worth
  one review over `apps/web` (SSE route lifecycle, error paths, input edges).
- **Run the live e2e** — `npm run smoke` (and a Playwright UI pass) against the
  deployed stack, once it's up.

## Phase 2 — Intelligence (Tier B): "the wow"

Go from a fixed pipeline to one that *reasons about retrieval* — while keeping
everything traced. Proposed sub-phases:

### 2.1 Query transformation
Rewrite a vague/conversational question into better retrieval queries before
searching: **rewrite** (clean up), **HyDE** (embed a hypothetical answer), and
**decomposition** (split a multi-part question into sub-questions, retrieve each).
- *Why:* retrieval is query-sensitive (the `rag-glassbox` LBW lesson) — the single
  highest-leverage upgrade after hybrid + rerank.
- *How:* a `transformQuery(query, generator, mode)` in core that returns one or
  more queries; `retrieve` runs each and merges. New trace stage: the transformed
  queries and which hits came from which.

### 2.2 Parent–child ("small-to-big") chunking
Embed **small** chunks for retrieval precision, but return their **larger parent**
for answer context.
- *Why:* small chunks retrieve accurately; big chunks answer better. Best of both.
- *How:* the chunker emits parent/child links; the store keeps both; retrieval
  matches on children, hydrates parents. Extends `Chunk` + the schema.

### 2.3 Agentic RAG (the headline)
An agent that decides *when* and *what* to retrieve, loops (**iterative**
multi-step retrieval), and **self-corrects** (Self-RAG / CRAG: critique the
retrieved context, re-retrieve or refuse). Can use tools. Fully traced — the trace
becomes a multi-step transcript.
- *Why:* the flagship differentiator; turns single-shot RAG into a reasoning loop.
- *How:* a controller over the existing `retrieve` + `answerQuestion` + a critique
  step, with a step budget and a per-step trace. Provider-agnostic (any
  `GenerationProvider`). This is where the deferred **reranker** and the
  **faithfulness** check pay off inside the loop.

### 2.4 Multimodal ingestion (optional, or folded into parsing)
Tables / images / charts from PDFs and slides.

## Then — Phase 3 (Enterprise)
Multi-tenancy + access-control-aware retrieval, connectors (Drive/Notion/S3),
optional GraphRAG per-KB, ColBERT/late-interaction, long-context strategies. See
the [ROADMAP](../ROADMAP.md).

## Sequencing

A sensible order: **2.1 query transformation** (cheap, big quality win, extends the
trace) → **2.3 agentic RAG** (the wow; reuses 2.1 as a tool) → **2.2 parent–child**
(a retrieval-quality upgrade that agentic RAG benefits from). Backlog items slot in
opportunistically — the **reranker adapter** is worth doing before 2.3 so the agent
can lean on it.
