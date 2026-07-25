# lucid-rag — Roadmap

**A self-hostable, provider-agnostic, *observable* corporate RAG starter.** Bring your own keys and your own data, run it locally or on your own infra, and — true to the brand — *see through* every step of retrieval instead of trusting a black box.

`lucid-rag` is the production sibling of [`rag-glassbox`](https://github.com/) (the teaching demo). The demo makes retrieval *visible*; this makes it *deployable* — without losing the visibility.

> This document is the north star. It records **where we are** and **where we're going**, tier by tier. Update the status markers as phases land.

---

## Principles (non-negotiable)

1. **Self-hostable first.** `git clone` → `docker compose up` → add keys → ingest data → ask questions. No mandatory SaaS, no vendor lock-in. An open-source starter you own.
2. **Provider-agnostic & local-first.** Every model is behind an interface. Run fully local (Ollama + local embeddings + local reranker) with **no API key**, or drop in Claude / OpenAI / Voyage / Cohere by setting an env var. Your data never has to leave your infra.
3. **Observable ("see-through").** Every query produces a full **trace**: the dense candidates, the sparse candidates, the fused ranking, the rerank re-ordering, the near-misses, the exact prompt, and the citations — surfaced in the UI. This is our differentiator versus the dozens of generic RAG starters.
4. **Grounded & honest.** Answers cite their sources and are checked for faithfulness; the system says "I don't know" rather than guessing; and we ship an **evaluation harness** so quality is measured, not vibed.
5. **Modular.** Retrieval strategies, providers, chunkers, and stores are pluggable. New techniques slot in without rewrites.

## Non-goals (deliberately)

- **No multi-tenant SaaS in the core** (auth, billing, org management). Phase 1 is single-tenant / self-hosted. Multi-tenancy is a Phase 3 add-on.
- **No GraphRAG in the core pipeline.** It's expensive and only wins on relational/global queries. It arrives in Phase 3 as an *optional, per-knowledge-base module*, never the backbone.
- **No "every buzzword" bloat.** We add a technique only when it earns its ROI for real corporate questions.

---

## Architecture at a glance

```
  monorepo (npm workspaces)
  ├── packages/core        provider-agnostic RAG engine — zero runtime deps.
  │                        Contracts + orchestration: chunking, contextualizer,
  │                        hybrid retrieval + rerank, generation + citations,
  │                        eval, and the observable trace. Talks to storage
  │                        through a VectorStore interface (DB-agnostic).
  │
  └── apps/web             Next.js full-stack app (self-hostable):
                           UI (upload data, add keys, chat, trace viewer) +
                           API routes + the Postgres/pgvector VectorStore impl +
                           ingestion workers.

  Postgres + pgvector      the store (dense vectors + full-text/sparse + metadata),
  (via docker-compose)     row/document-level filtering, and later access control.
```

- **Store: Postgres + `pgvector`.** One database handles dense vector search (`pgvector`), sparse/keyword search (Postgres full-text or a BM25 extension), metadata filtering, and (later) access control. No separate vector DB to run.
- **Interfaces are lifted from `rag-glassbox`** (`EmbeddingProvider`, `GenerationProvider`, the retrieval-trace idea) and extended here (`Reranker`, `VectorStore`, contextual chunks, faithfulness). Concepts stay consistent across both repos.

---

## The tier model (Tier A / B / C)

The *techniques* are grouped by ROI; the *phases* below schedule them.

- **Tier A — highest ROI, table stakes for a serious system:** layout-aware ingestion, hybrid retrieval, **reranking**, **contextual retrieval**, metadata/permission-aware filtering, **citations + faithfulness**, **evaluation**, and the **observable trace**.
- **Tier B — high value, the "wow":** query transformation (rewrite / HyDE / decomposition), parent–child ("small-to-big") chunking, and **agentic RAG** (iterative + corrective retrieval, self-check).
- **Tier C — specialized / optional:** GraphRAG, ColBERT / late-interaction, fine-tuned embeddings, long-context strategies.

---

## Phases

### ✅/🔧 Phase 1 — Foundation: "a RAG starter you can see through"  ← **WE ARE HERE**

*Goal: single-tenant, self-hostable, genuinely good retrieval, fully observable. This alone beats most RAG repos.* Delivers **Tier A**.

> **Current position (updated):** Phase **1.3 is complete** — the retrieval engine `retrieve()` in `@lucid-rag/core`: dense + sparse candidates (run concurrently) → min-max normalize + weighted fusion (keyword / semantic / hybrid, blended by `semanticWeight`) → optional cross-encoder rerank → top-k, all recorded in the multi-stage `RetrievalTrace` (dense / sparse / fused / reranked stages, near-misses, per-stage timings). 30 core unit tests, hardened by an adversarial find→verify review (2 confirmed fixes — normalize over hydratable candidates only, snapshot params into the trace; 6 false alarms refuted). **Next up: Phase 1.4** — grounded generation (numbered sources, inline citations, faithfulness check, provider-agnostic streaming).

| # | Capability | What it means | Status |
|---|---|---|---|
| 1.0 | Repo + core contracts | Monorepo, docker-compose, and the shared interfaces (providers, reranker, vector store, trace) | ✅ done |
| 1.1 | Postgres + pgvector store | Schema + `VectorStore` impl: dense (pgvector) + sparse (full-text) + metadata filter | ✅ done |
| 1.2 | Ingestion pipeline | Upload/parse → chunk → **contextualize** (LLM situating blurb per chunk) → embed → index | ✅ done |
| 1.3 | Hybrid retrieval + reranking | Dense + sparse candidates → fuse → **cross-encoder rerank** → top-k, with the full trace | ✅ done |
| 1.4 | Grounded generation | Numbered sources, **inline citations**, **faithfulness check**, provider-agnostic streaming | ⬜ **next** |
| 1.5 | Evaluation harness | RAGAS-style metrics: context precision/recall, faithfulness, answer relevance | ⬜ |
| 1.6 | Web app + self-host | BYO-keys + data upload UI, chat, **trace viewer**; `docker compose up` quickstart; e2e verified | ⬜ |

### ⬜ Phase 2 — Intelligence: the "wow"

*Goal: go from a fixed pipeline to a system that reasons about retrieval.* Delivers **Tier B**.

- **Query transformation** — rewriting, HyDE (hypothetical-document embeddings), and sub-question decomposition for complex questions.
- **Parent–child / small-to-big chunking** — embed small chunks for precision, return their larger parent for context.
- **Agentic RAG (headline)** — an agent that decides *when* and *what* to retrieve, does **iterative** multi-step retrieval, **self-corrects** (Self-RAG / CRAG: critique results, re-retrieve or refuse), and can use tools. Fully traced.
- **Multimodal ingestion** — tables, images, and charts from PDFs/slides (if not already in 1.2).

### ⬜ Phase 3 — Enterprise: scale, connect, relate

*Goal: the true "corporate" layer.* Delivers **Tier C** + productionization.

- **Multi-tenancy + access-control-aware retrieval** — per-tenant isolation; results filtered by the asker's permissions (document/row-level).
- **Connectors** — Google Drive, Notion, Confluence, S3, web crawl, with incremental sync.
- **GraphRAG (optional module)** — entity/relationship extraction + graph retrieval, enabled **per knowledge base** for relational/global queries. Never the default.
- **Advanced retrieval options** — ColBERT / late-interaction, fine-tuned/domain embeddings.
- **Long-context strategies** — "retrieve to select, long-context to read," exploiting 1M-token windows where it beats chunk-stuffing.

---

## Relationship to `rag-glassbox`

| | `rag-glassbox` | `lucid-rag` |
|---|---|---|
| Purpose | teach how retrieval works | deploy a real corporate RAG |
| Data | 3 fixed demo corpora | your data, ingested |
| Store | committed JSON, brute-force | Postgres + pgvector |
| Retrieval | keyword / semantic / hybrid | + reranking, contextual, agentic |
| Shared DNA | provider-agnostic, local-first, **observable trace** — carried into both | |

Both are linked from the website: *the idea made visible → the production system built on it.*
