# @lucid-rag/store-postgres

Postgres + `pgvector` implementation of the core [`VectorStore`](../core/src/vector-store.ts) contract — **Phase 1.1** of the [roadmap](../../ROADMAP.md). One database serves all three retrieval signals plus filtering:

- **Dense** vector search — `pgvector`, cosine (`<=>`); score returned as cosine *similarity* (`1 − distance`).
- **Sparse** keyword search — Postgres full-text over a generated `tsvector` column (`websearch_to_tsquery` + `ts_rank_cd`).
- **Metadata / permission filtering** — `jsonb` columns with equality, membership (`in`), and numeric ranges (`gte`/`lte`), all fully parameterized.

## Schema

`knowledge_base → document → chunk`, with `ON DELETE CASCADE` all the way down (so `deleteDocument` / `deleteKnowledgeBase` clean up chunks automatically). The `chunk` table carries the `embedding vector`, a generated `tsv`, and a `metadata jsonb`, with GIN indexes on `tsv` and `metadata`. See [`src/schema.ts`](src/schema.ts) for the full DDL and the notes on dimensions + ANN indexing.

> **Dimensions & indexing.** Each knowledge base pins its own embedding model/dimensions, so the `embedding` column is an unconstrained `vector` and dense search is *exact* KNN scoped by `knowledge_base_id` (correct at any dimension). For a large single-model deployment, add a partial HNSW index — see the comment in `schema.ts`.

## Usage

```ts
import { PgVectorStore } from '@lucid-rag/store-postgres';

const store = new PgVectorStore(process.env.DATABASE_URL!); // or pass an existing pg Pool
await store.init(); // create extension + tables + indexes (idempotent)

await store.createKnowledgeBase({ id: 'kb1', name: 'Handbook', embeddingModel: 'voyage-3.5-lite', embeddingDims: 1024 });
await store.upsertDocument({ id: 'doc1', knowledgeBaseId: 'kb1', title: 'HR Handbook' });
await store.upsert([{ chunk, embedding }]);

const dense = await store.searchDense('kb1', queryEmbedding, 10, { dept: 'hr' });
const sparse = await store.searchSparse('kb1', 'expense policy', 10);
const hydrated = await store.getChunks(dense.map((h) => h.chunkId));

await store.close();
```

The `VectorStore` interface (`upsert`, `searchDense`, `searchSparse`, `getChunks`, `deleteDocument`) is what the core engine talks to; the `createKnowledgeBase` / `upsertDocument` / `deleteKnowledgeBase` helpers are the management surface the ingestion pipeline (Phase 1.2) uses.

## Tests

```bash
npm run test --workspace @lucid-rag/store-postgres        # unit tests (no DB)
npm run db:up                                             # start Postgres+pgvector (Docker), then:
npm run test --workspace @lucid-rag/store-postgres        # runs the integration suite too
```

Unit tests cover the SQL builders. The integration suite runs against a live database and **skips itself** when none is reachable, so it never blocks a Docker-less run.
