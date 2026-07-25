# lucid-rag

**A self-hostable, provider-agnostic, observable corporate RAG starter.** Bring your own keys and your own data, run it locally or on your own infra, and *see through* every step of retrieval — dense + sparse candidates, the fused ranking, the reranker's re-ordering, the near-misses, the exact prompt, and every citation.

The production sibling of [`rag-glassbox`](https://github.com/) (the teaching demo): the demo makes retrieval *visible*; this makes it *deployable* — without losing the visibility.

> 🧭 **Start with the [ROADMAP](./ROADMAP.md)** — it lays out the phased plan (Phase 1 foundation → Phase 2 agentic → Phase 3 enterprise), the principles, and where the build currently is.

## What makes it different

- **Self-hostable.** `git clone` → `docker compose up` → add keys → ingest data → ask. No mandatory SaaS.
- **Provider-agnostic & local-first.** Run fully local (Ollama + local embeddings + local reranker) with **no API key and no data leaving your machine**, or drop in Claude / OpenAI / Voyage / Cohere with one env var.
- **Observable.** Every answer ships with a full retrieval **trace** you can inspect — the core selling point.
- **Grounded.** Inline citations, a faithfulness check, and a built-in **evaluation harness** so quality is measured, not guessed.

## Stack

- **Store:** Postgres + `pgvector` (dense vectors + sparse/full-text + metadata filtering in one database).
- **Core:** a zero-dependency, provider-agnostic RAG engine (`packages/core`).
- **App:** a Next.js self-hostable web app (`apps/web`) — data upload, key management, chat, and the trace viewer.

## Status

**Phase 1 (foundation) in progress.** See the [ROADMAP](./ROADMAP.md) for the tier-by-tier plan and current status. Quickstart instructions land with the web tier (Phase 1.6).
