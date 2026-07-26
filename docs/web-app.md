# Phase 1.6 — Web App + Self-Host (design)

Status: in progress. Plan + reasoning up front; the [DEVLOG](../DEVLOG.md) records
outcomes and the [Bug Ledger](./bug-ledger.md) the fixes. Last piece of Phase 1.

## Goal

Make lucid-rag *runnable by a human*: upload data, add keys, chat, and see the
glass-box trace — deployed by **self-hosting** the full product (`docker compose
up`) on a free always-on VM.

## Deployment decision (self-host only) and why

**Chosen (revised with the user): Path A — self-host, no hosted demo.** lucid-rag
needs a *stateful* Postgres+pgvector DB and a *long-running* ingestion pipeline
(parse → chunk → LLM-contextualize → embed → index — minutes for a big doc).
Vercel functions are stateless and time-limited, so a full hosted app doesn't fit
serverless; rather than ship a stripped-down hosted demo, we run the real thing.

**How.** Everything runs in containers on one machine you control: a pgvector
container + the Next app container (+ optional Ollama). Ingestion is a normal
long-lived process — no timeout. **Local-first works** (Ollama + local embeddings,
no keys, data never leaves the box).

**Where — free, always-on.** A **free Oracle Cloud Free Tier** VM (Ampere ARM, up
to 4 cores / 24 GB RAM, always free) comfortably runs the whole stack: `docker
compose up` on the VM, expose the app port, done. (An earlier "A + B" plan that
added a Vercel + Neon query-only demo was dropped in favor of shipping only the
real self-hostable product.)

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

## Ingestion

`/api/ingest` runs the full pipeline in-request. The self-hosted server is
long-lived, so contextualize + embed over many chunks has no serverless timeout
to fear — the whole point of choosing self-host.

## UI (1.6c)

One client component (`Studio`) over the three routes, plus a `TraceView`. The
point is to make the trace *visible*:

- **Upload** — paste text or load a `.txt`/`.md` file; set the KB + document ids;
  optional per-chunk contextualization. POSTs `/api/ingest`.
- **Ask** — query + mode (hybrid/semantic/keyword) + optional faithfulness check.
  Consumes the `/api/ask` SSE stream: the answer streams token-by-token, then the
  citations, faithfulness verdict, and full trace render on `done`.
- **Trace viewer** — the glass box: per-stage timings, the top-k **results** (with
  their `[n]` citation numbers and dense/sparse/fused/rerank scores), the
  **near-misses** just below the cutoff, and collapsible **stage** lists
  (dense / sparse / fused / reranked).

Client SSE is parsed in `lib/client.ts` (fetch + `ReadableStream`, since
`EventSource` is GET-only). Styling is a small bespoke light/dark CSS file.
Document parsing beyond plaintext/Markdown (PDF, docx) is deferred.

## Config / env

`DATABASE_URL` + provider keys (see `.env.example`), plus:
- `LUCID_READONLY=true` → optional read-only mode (disables the ingest route +
  upload UI) for a locked-down public self-host instance.
- Model/dim overrides for each provider.

## Sub-phases

1.6a providers ✅ · 1.6b `apps/web` + API routes (ingest, ask) · 1.6c UI (upload,
chat, trace viewer) · 1.6d `docker-compose` + quickstart · 1.6e Oracle Cloud
Free-Tier deploy guide (`docker compose up` on the VM) · 1.6f e2e verification.

## Testing

Providers: unit-test body-builders, response parsers, SSE parsing, and `resolve`
with a mocked fetch (no keys/network). App: API-route logic against fakes; a
Playwright e2e (headless) once the UI lands, as in rag-glassbox. Each sub-phase
gets the same adversarial find→verify review.

## Open questions / future

- Anthropic + reranker adapters (additive).
- Background/queued ingestion for a *hosted* full app (Path C) — out of scope here.
- Auth/multi-tenant — Phase 3.
