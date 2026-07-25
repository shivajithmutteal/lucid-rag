/**
 * Retrieval pipeline (Phase 1.3): the observable heart of lucid-rag.
 *
 *   dense (vector) ┐
 *                  ├─ fuse (min-max normalize + weighted) ─ [rerank] ─ top-k
 *   sparse (FTS)   ┘
 *
 * Every stage is recorded in a {@link RetrievalTrace} — the dense candidates,
 * the sparse candidates, the fused ranking, the reranked ranking, the near-
 * misses just below the cutoff, and per-stage timings — so the whole pipeline
 * stays see-through. Retrievers and the reranker are injected; the store is the
 * only thing that touches the database.
 */
import type { EmbeddingProvider, Reranker } from './providers';
import type { RetrievalParams, RetrievalTrace, ScoredChunk } from './types';
import type { VectorHit, VectorStore } from './vector-store';

export interface RetrieveDeps {
  store: VectorStore;
  embedder: EmbeddingProvider;
  /** Required only when `params.rerank` is true. */
  reranker?: Reranker;
}

/** Scale a list of scores to [0, 1]. All-equal (or single) scores map to 1. */
function minMax(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return values.map(() => 1);
  return values.map((v) => (v - min) / range);
}

/** Assign 1-based ranks in current array order; returns the same array. */
function withRanks(chunks: ScoredChunk[]): ScoredChunk[] {
  chunks.forEach((c, i) => (c.rank = i + 1));
  return chunks;
}

export async function retrieve(
  knowledgeBaseId: string,
  query: string,
  params: RetrievalParams,
  deps: RetrieveDeps,
): Promise<RetrievalTrace> {
  const { store, embedder, reranker } = deps;
  const { mode, candidateK, topK } = params;
  const nearMissCount = params.nearMissCount ?? 3;
  const semanticWeight = params.semanticWeight ?? 0.5;
  const doRerank = params.rerank ?? false;
  if (doRerank && !reranker) {
    throw new Error('retrieve: params.rerank=true requires deps.reranker');
  }
  const runDense = mode === 'semantic' || mode === 'hybrid';
  const runSparse = mode === 'keyword' || mode === 'hybrid';

  const timings: Record<string, number> = {};
  const t0 = performance.now();

  // ── Candidate retrieval (dense + sparse run concurrently) ──
  const densePromise: Promise<VectorHit[]> = runDense
    ? (async () => {
        const ts = performance.now();
        const [queryVec] = await embedder.embed([query]);
        const hits = await store.searchDense(knowledgeBaseId, queryVec, candidateK, params.filter);
        timings.dense = performance.now() - ts;
        return hits;
      })()
    : Promise.resolve<VectorHit[]>([]);
  const sparsePromise: Promise<VectorHit[]> = runSparse
    ? (async () => {
        const ts = performance.now();
        const hits = await store.searchSparse(knowledgeBaseId, query, candidateK, params.filter);
        timings.sparse = performance.now() - ts;
        return hits;
      })()
    : Promise.resolve<VectorHit[]>([]);
  const [denseHits, sparseHits] = await Promise.all([densePromise, sparsePromise]);

  // ── Hydrate the union of candidate chunks ──
  const ids = Array.from(new Set([...denseHits, ...sparseHits].map((h) => h.chunkId)));
  const chunks = await store.getChunks(ids);
  const chunkById = new Map(chunks.map((c) => [c.id, c] as const));
  const denseScoreById = new Map(denseHits.map((h) => [h.chunkId, h.score] as const));
  const sparseScoreById = new Map(sparseHits.map((h) => [h.chunkId, h.score] as const));

  // Raw per-retriever stages (in the store's returned order; unhydratable ids dropped).
  const stageDense = runDense
    ? withRanks(
        denseHits
          .filter((h) => chunkById.has(h.chunkId))
          .map((h) => ({ chunk: chunkById.get(h.chunkId)!, denseScore: h.score, score: h.score, rank: 0 })),
      )
    : undefined;
  const stageSparse = runSparse
    ? withRanks(
        sparseHits
          .filter((h) => chunkById.has(h.chunkId))
          .map((h) => ({ chunk: chunkById.get(h.chunkId)!, sparseScore: h.score, score: h.score, rank: 0 })),
      )
    : undefined;

  // ── Fuse: normalize each signal over its own candidate set, then combine ──
  const tf = performance.now();
  // Normalize over the HYDRATABLE hits only — matching the fused/stage domain —
  // so a candidate that getChunks dropped (e.g. deleted between search and
  // hydrate) can't set the min/max and skew the surviving chunks' scores.
  const denseHydrated = denseHits.filter((h) => chunkById.has(h.chunkId));
  const sparseHydrated = sparseHits.filter((h) => chunkById.has(h.chunkId));
  const normDenseById = new Map(
    minMax(denseHydrated.map((h) => h.score)).map((n, i) => [denseHydrated[i].chunkId, n] as const),
  );
  const normSparseById = new Map(
    minMax(sparseHydrated.map((h) => h.score)).map((n, i) => [sparseHydrated[i].chunkId, n] as const),
  );
  const fused: ScoredChunk[] = ids
    .filter((id) => chunkById.has(id))
    .map((id) => {
      const normDense = normDenseById.get(id) ?? 0;
      const normSparse = normSparseById.get(id) ?? 0;
      const fusedScore =
        mode === 'keyword'
          ? normSparse
          : mode === 'semantic'
            ? normDense
            : semanticWeight * normDense + (1 - semanticWeight) * normSparse;
      return {
        chunk: chunkById.get(id)!,
        denseScore: denseScoreById.get(id),
        sparseScore: sparseScoreById.get(id),
        fusedScore,
        score: fusedScore,
        rank: 0,
      };
    });
  fused.sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0));
  withRanks(fused);
  timings.fuse = performance.now() - tf;

  // ── Optional cross-encoder rerank over the fused candidates ──
  let reranked: ScoredChunk[] | undefined;
  let finalRanking = fused;
  if (doRerank && reranker && fused.length > 0) {
    const tr = performance.now();
    const rr = await reranker.rerank(query, fused.map((s) => s.chunk.text));
    reranked = withRanks(
      rr
        .filter((r) => r.index >= 0 && r.index < fused.length)
        .map((r) => ({ ...fused[r.index], rerankScore: r.score, score: r.score, rank: 0 })),
    );
    timings.rerank = performance.now() - tr;
    finalRanking = reranked;
  }

  // ── Select the final top-k plus the near-misses just below the cutoff ──
  const results = finalRanking.slice(0, topK);
  const nearMisses = finalRanking.slice(topK, topK + nearMissCount);
  timings.total = performance.now() - t0;

  return {
    query,
    // Snapshot the params so the trace is a faithful record even if the caller
    // reuses/mutates its params object across a parameter sweep.
    params: { ...params },
    stages: { dense: stageDense, sparse: stageSparse, fused, reranked },
    results,
    nearMisses,
    timings,
  };
}
