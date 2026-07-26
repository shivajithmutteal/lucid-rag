# Phase 1.6 — Web App + Self-Host (design)

Status: in progress. Plan + reasoning up front; the [DEVLOG](../DEVLOG.md) records
outcomes and the [Bug Ledger](./bug-ledger.md) the fixes. Last piece of Phase 1.

## Goal

Make lucid-rag *runnable by a human*: upload data, add keys, chat, and see the
glass-box trace — delivered two ways (decided with the user):

- **Path A — self-host (`docker compose up`)**: the real, full-featured product.
- **Path B — free hosted demo**: a public, query-only showcase (like rag.mutteal.com).

## Deployment decision (A + B) and why

**The serverless problem.** lucid-rag needs a *stateful* Postgres+pgvector DB and
a *long-running* ingestion pipeline (parse → chunk → LLM-contextualize → embed →
index — minutes for a big doc). Vercel functions are stateless and time-limited,
so Vercel can host the UI + short read routes but **not** the DB and **not** live
ingestion. (This is exactly why rag-glassbox went static/client-side; lucid-rag
can't.)

**Path A — self-host.** Everything runs in containers on one machine you control:
a pgvector container + the Next app container (+ optional Ollama). Ingestion is a
normal long-lived process — no timeout. Free on your own hardware or a free
always-on VM (Oracle Cloud Free Tier). **Local-first works here and only here**
(Ollama + local embeddings, no keys, data never leaves the box).

**Path B — hosted demo.** Ingest a sample corpus **offline, once** (writing vectors
into a free managed pgvector — **Neon** or **Supabase**); deploy the Next app on
Vercel in **query-only** mode reading that DB. No live upload → no serverless
timeout. Generation reuses the free-tier failover chain (Groq → Gemini →
OpenRouter) already proven in rag-glassbox. This mirrors rag-glassbox's
"precomputed corpus + hosted read-only demo" pattern, adapted to a real DB.

The two share one codebase; the only differences are **config** (DATABASE_URL +
provider keys) and a **query-only flag** that hides the upload UI on the demo.

## Architecture

```
packages/core            engine (done: chunk, retrieve, answer, eval, trace)
packages/store-postgres  pgvector VectorStore + DocumentStore (done)
packages/providers       concrete EmbeddingProvider / GenerationProvider adapters   ← 1.6a
apps/web                 Next.js: API routes (ingest, ask) + UI (upload, chat, trace)  ← 1.6b/c
docker-compose.yml       app + db (+ ollama) for self-host                          ← 1.6d
```

## Provider strategy (1.6a)

One **OpenAI-compatible** adapter covers most providers by swapping `baseUrl` +
`model` + `apiKey`:

- **Embeddings** (`/embeddings`, `{data:[{embedding}]}` shape): OpenAI, **Voyage**
  (same shape), and **Ollama** (`/v1`) — all one adapter.
- **Generation** (`/chat/completions`, SSE streaming): OpenAI, **Groq**, **Gemini**
  (OpenAI-compat endpoint), **OpenRouter**, and **Ollama** — all one adapter.

`resolve.ts` picks the provider from env (first key wins), defaulting to **Ollama
(local-first)**. Each embedding model's `dims` is pinned (text-embedding-3-small
1536, voyage-3.5-lite 1024, nomic-embed-text 768), overridable via `EMBED_DIMS`.
Anthropic (`/v1/messages`, different shape) and rerankers (Cohere/Voyage) are
**deferred** to a later sub-phase — the app runs on OpenAI-compat + Ollama, and
`retrieve()` already makes rerank optional.

Adapters take an injectable `fetch` so the request/response logic is unit-testable
with no network.

## Ingestion & the serverless constraint

- **Self-host (A):** `/api/ingest` runs the full pipeline in-request (long-lived
  server, no timeout).
- **Demo (B):** a CLI `seed` script runs the pipeline offline against the demo DB;
  the hosted app never ingests. Query-only mode returns a clear error if upload is
  attempted.

## Config / env

`DATABASE_URL` + provider keys (see `.env.example`), plus:
- `LUCID_READONLY=true` → query-only (demo) — disables ingest routes + upload UI.
- Model/dim overrides for each provider.

## Testing

Providers: unit-test body-builders, response parsers, SSE parsing, and `resolve`
with a mocked fetch (no keys/network). App: API-route logic against fakes; a
Playwright e2e (headless) once the UI lands, as in rag-glassbox. Each sub-phase
gets the same adversarial find→verify review.

## Open questions / future

- Anthropic + reranker adapters (additive).
- Background/queued ingestion for a *hosted* full app (Path C) — out of scope here.
- Auth/multi-tenant — Phase 3.
