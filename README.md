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

## Quickstart (self-host)

```bash
git clone https://github.com/shivajithmutteal/lucid-rag
cd lucid-rag
cp .env.example .env          # add a provider key (e.g. GROQ_API_KEY, free tier) — or leave empty for local Ollama
docker compose up --build     # builds the web app + starts Postgres/pgvector
```

Open **http://localhost:3000** — upload a document (paste text or a `.txt`/`.md`
file), ask a question, and watch the answer stream in with its full glass-box trace.
The database schema is created automatically on first use.

- **Providers** resolve from env (first key wins), defaulting to **local Ollama** —
  no key, no data leaving your machine. See [`.env.example`](./.env.example). For a
  local-first run, uncomment the `ollama` service in `docker-compose.yml` and set
  `OLLAMA_HOST=http://ollama:11434`.
- **Read-only** public instance: set `LUCID_READONLY=true` to disable uploads.
- **Deploy** on any Docker host — including a **free Oracle Cloud Free Tier** VM
  (see [`docs/web-app.md`](./docs/web-app.md)).

### Develop (without Docker)

```bash
docker compose up -d db            # just the database
npm install
npm test --workspaces --if-present # the package test suites
npm run dev -w @lucid-rag/web      # http://localhost:3000 (DATABASE_URL from .env)
```

## Status

**Phase 1 (foundation) — Tier A complete; the web app (1.6) is landing.** See the
[ROADMAP](./ROADMAP.md) for the plan, the [DEVLOG](./DEVLOG.md) for how it was built,
and the [Bug Ledger](./docs/bug-ledger.md) for every reviewed fix.
