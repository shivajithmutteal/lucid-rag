import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider, RerankResult, Reranker } from '../src/providers';
import type { Chunk } from '../src/types';
import type { VectorHit, VectorStore } from '../src/vector-store';
import { retrieve } from '../src/retrieve';

const CHUNKS: Chunk[] = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id, i) => ({
  id,
  documentId: 'd',
  knowledgeBaseId: 'kb',
  index: i,
  text: `text ${id}`,
  embedText: `text ${id}`,
  charStart: 0,
  charEnd: 6,
  tokenCount: 2,
  metadata: {},
}));

class FakeStore implements VectorStore {
  constructor(
    private dense: VectorHit[],
    private sparse: VectorHit[],
  ) {}
  async upsert(): Promise<void> {}
  async searchDense(_kb: string, _q: number[], k: number): Promise<VectorHit[]> {
    return this.dense.slice(0, k);
  }
  async searchSparse(_kb: string, _q: string, k: number): Promise<VectorHit[]> {
    return this.sparse.slice(0, k);
  }
  async getChunks(ids: string[]): Promise<Chunk[]> {
    return ids.map((id) => CHUNKS.find((c) => c.id === id)).filter((c): c is Chunk => !!c);
  }
  async deleteDocument(): Promise<void> {}
}

class FakeEmbedder implements EmbeddingProvider {
  readonly id = 'e';
  readonly model = 'e';
  readonly dims = 3;
  embedCalls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    return texts.map(() => [1, 0, 0]);
  }
}

/** Reverses the candidate order (last fused becomes best), to prove rerank reorders. */
class ReversingReranker implements Reranker {
  readonly id = 'r';
  readonly model = 'r';
  async rerank(_query: string, documents: string[]): Promise<RerankResult[]> {
    return documents.map((_, i) => ({ index: i, score: i })).sort((a, b) => b.score - a.score);
  }
}

const ids = (chunks: { chunk: Chunk }[]) => chunks.map((c) => c.chunk.id);

describe('retrieve', () => {
  it('semantic mode: dense only, ranked by similarity, no sparse stage', async () => {
    const store = new FakeStore(
      [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }, { chunkId: 'c3', score: 0.5 }],
      [],
    );
    const trace = await retrieve('kb', 'q', { mode: 'semantic', candidateK: 3, topK: 3 }, { store, embedder: new FakeEmbedder() });
    expect(ids(trace.results)).toEqual(['c1', 'c2', 'c3']);
    expect(trace.stages.dense).toHaveLength(3);
    expect(trace.stages.sparse).toBeUndefined();
    expect(trace.results[0].denseScore).toBe(0.9);
  });

  it('keyword mode: sparse only', async () => {
    const store = new FakeStore([], [{ chunkId: 'c2', score: 5 }, { chunkId: 'c4', score: 3 }, { chunkId: 'c1', score: 1 }]);
    const trace = await retrieve('kb', 'q', { mode: 'keyword', candidateK: 3, topK: 3 }, { store, embedder: new FakeEmbedder() });
    expect(ids(trace.results)).toEqual(['c2', 'c4', 'c1']);
    expect(trace.stages.dense).toBeUndefined();
    expect(trace.stages.sparse).toHaveLength(3);
  });

  it('hybrid mode: fuses normalized dense + sparse, favouring chunks in both', async () => {
    const store = new FakeStore(
      [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }, { chunkId: 'c3', score: 0.5 }],
      [{ chunkId: 'c2', score: 5 }, { chunkId: 'c4', score: 3 }, { chunkId: 'c1', score: 1 }],
    );
    const trace = await retrieve('kb', 'q', { mode: 'hybrid', candidateK: 3, topK: 3, semanticWeight: 0.5 }, { store, embedder: new FakeEmbedder() });
    // Fused: c2=0.875, c1=0.5, c4=0.25, c3=0
    expect(ids(trace.results)).toEqual(['c2', 'c1', 'c4']);
    expect(ids(trace.nearMisses)).toEqual(['c3']);
    expect(trace.results[0].fusedScore).toBeCloseTo(0.875, 5);
    // A chunk found by both retrievers carries both raw scores.
    expect(trace.results[0].denseScore).toBe(0.8);
    expect(trace.results[0].sparseScore).toBe(5);
  });

  it('rerank reorders the fused candidates and records the reranked stage', async () => {
    const store = new FakeStore(
      [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.8 }, { chunkId: 'c3', score: 0.5 }],
      [{ chunkId: 'c2', score: 5 }, { chunkId: 'c4', score: 3 }, { chunkId: 'c1', score: 1 }],
    );
    const trace = await retrieve(
      'kb',
      'q',
      { mode: 'hybrid', candidateK: 3, topK: 3, rerank: true },
      { store, embedder: new FakeEmbedder(), reranker: new ReversingReranker() },
    );
    // Fused order is [c2,c1,c4,c3]; the reversing reranker flips it to [c3,c4,c1,c2].
    expect(trace.stages.reranked).toBeDefined();
    expect(ids(trace.results)).toEqual(['c3', 'c4', 'c1']);
    expect(trace.results[0].rerankScore).toBeDefined();
  });

  it('respects topK and keeps the requested number of near-misses', async () => {
    const store = new FakeStore(
      [
        { chunkId: 'c1', score: 0.9 },
        { chunkId: 'c2', score: 0.8 },
        { chunkId: 'c3', score: 0.7 },
        { chunkId: 'c4', score: 0.6 },
        { chunkId: 'c5', score: 0.5 },
      ],
      [],
    );
    const trace = await retrieve('kb', 'q', { mode: 'semantic', candidateK: 5, topK: 2, nearMissCount: 2 }, { store, embedder: new FakeEmbedder() });
    expect(ids(trace.results)).toEqual(['c1', 'c2']);
    expect(ids(trace.nearMisses)).toEqual(['c3', 'c4']);
    expect(trace.results.every((r, i) => r.rank === i + 1)).toBe(true);
  });

  it('throws if rerank is requested without a reranker', async () => {
    const store = new FakeStore([{ chunkId: 'c1', score: 1 }], []);
    await expect(
      retrieve('kb', 'q', { mode: 'semantic', candidateK: 3, topK: 3, rerank: true }, { store, embedder: new FakeEmbedder() }),
    ).rejects.toThrow(/reranker/);
  });

  it('keyword mode does not embed the query', async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore([], [{ chunkId: 'c1', score: 1 }]);
    await retrieve('kb', 'q', { mode: 'keyword', candidateK: 3, topK: 3 }, { store, embedder });
    expect(embedder.embedCalls).toBe(0);
  });

  it('normalizes over hydratable candidates only (a dropped hit does not skew scores)', async () => {
    // 'cX' is returned by dense search but is not in CHUNKS, so getChunks omits it.
    const store = new FakeStore(
      [{ chunkId: 'c1', score: 0.9 }, { chunkId: 'c2', score: 0.5 }, { chunkId: 'cX', score: 0.0 }],
      [],
    );
    const trace = await retrieve('kb', 'q', { mode: 'semantic', candidateK: 3, topK: 3 }, { store, embedder: new FakeEmbedder() });
    expect(ids(trace.results)).toEqual(['c1', 'c2']); // cX dropped
    // Normalized over the hydrated set [0.9, 0.5], c2 is the min → 0 (not 0.556).
    expect(trace.results[1].fusedScore).toBe(0);
  });

  it('snapshots params into the trace (a later mutation does not corrupt it)', async () => {
    const store = new FakeStore([{ chunkId: 'c1', score: 1 }], []);
    const params = { mode: 'semantic' as const, candidateK: 3, topK: 3 };
    const trace = await retrieve('kb', 'q', params, { store, embedder: new FakeEmbedder() });
    (params as { mode: string }).mode = 'keyword';
    expect(trace.params.mode).toBe('semantic');
  });
});
