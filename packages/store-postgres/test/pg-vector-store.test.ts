import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chunk, MetadataValue, UpsertChunk } from '@lucid-rag/core';
import { PgVectorStore } from '../src/index';

/**
 * Integration tests against a real Postgres + pgvector.
 *
 * They run only when a database is reachable (start one with `npm run db:up`
 * from the repo root). When it isn't, the whole suite is skipped so unit tests
 * and CI stay green without Docker. Set DATABASE_URL to override the target.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://lucid:lucid@localhost:5432/lucid';
const KB_ID = 'itest-store-postgres';
const DOC_ID = 'itest-doc-1';

async function dbReachable(): Promise<boolean> {
  const s = new PgVectorStore(DATABASE_URL);
  try {
    await s.init();
    return true;
  } catch {
    return false;
  } finally {
    await s.close().catch(() => {});
  }
}

// Evaluated at collection time so `describe.skip` can gate the whole suite.
const DB_OK = await dbReachable();
const suite = DB_OK ? describe : describe.skip;

if (!DB_OK) {
  // eslint-disable-next-line no-console
  console.warn(`[store-postgres] skipping integration tests — no database at ${DATABASE_URL}`);
}

function mkChunk(
  id: string,
  index: number,
  text: string,
  metadata: Record<string, MetadataValue>,
): Chunk {
  return {
    id,
    documentId: DOC_ID,
    knowledgeBaseId: KB_ID,
    index,
    text,
    embedText: text,
    charStart: 0,
    charEnd: text.length,
    tokenCount: text.split(/\s+/).length,
    metadata,
  };
}

suite('PgVectorStore (integration)', () => {
  const store = new PgVectorStore(DATABASE_URL);

  const chunks: UpsertChunk[] = [
    { chunk: mkChunk('c1', 0, 'The leave policy grants twenty days of annual leave.', { topic: 'leave' }), embedding: [1, 0, 0] },
    { chunk: mkChunk('c2', 1, 'Expense reports must be filed within thirty days.', { topic: 'expense' }), embedding: [0, 1, 0] },
    { chunk: mkChunk('c3', 2, 'Remote work is permitted three days each week.', { topic: 'remote' }), embedding: [0, 0, 1] },
  ];

  beforeAll(async () => {
    await store.init();
    await store.deleteKnowledgeBase(KB_ID); // clean slate from any prior run
    await store.createKnowledgeBase({ id: KB_ID, name: 'Integration KB', embeddingModel: 'test-3d', embeddingDims: 3 });
    await store.upsertDocument({ id: DOC_ID, knowledgeBaseId: KB_ID, title: 'HR Handbook', metadata: { source: 'hr' } });
    await store.upsert(chunks);
  });

  afterAll(async () => {
    await store.deleteKnowledgeBase(KB_ID).catch(() => {});
    await store.close();
  });

  it('dense search ranks by cosine similarity', async () => {
    const hits = await store.searchDense(KB_ID, [1, 0, 0], 3);
    expect(hits[0]?.chunkId).toBe('c1');
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it('sparse search finds chunks by keyword', async () => {
    const hits = await store.searchSparse(KB_ID, 'expense reports', 5);
    expect(hits.map((h) => h.chunkId)).toContain('c2');
  });

  it('metadata filter narrows results (dense)', async () => {
    const hits = await store.searchDense(KB_ID, [1, 0, 0], 3, { topic: 'remote' });
    expect(hits.map((h) => h.chunkId)).toEqual(['c3']);
  });

  it('metadata filter narrows results (sparse)', async () => {
    const hits = await store.searchSparse(KB_ID, 'days', 5, { topic: { in: ['leave', 'expense'] } });
    const ids = hits.map((h) => h.chunkId).sort();
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('upsert overwrites an existing chunk', async () => {
    await store.upsert([{ chunk: mkChunk('c1', 0, 'Updated leave policy text.', { topic: 'leave' }), embedding: [1, 0, 0] }]);
    const [c1] = await store.getChunks(['c1']);
    expect(c1?.text).toBe('Updated leave policy text.');
  });

  it('getChunks hydrates and preserves requested order', async () => {
    const cs = await store.getChunks(['c3', 'c1']);
    expect(cs.map((c) => c.id)).toEqual(['c3', 'c1']);
    expect(cs[0]?.metadata.topic).toBe('remote');
  });

  it('numeric range filter excludes non-numeric values instead of erroring', async () => {
    await store.upsert([
      { chunk: mkChunk('r1', 10, 'Ticket resolved quickly.', { ts: 150 }), embedding: [0.9, 0.1, 0] },
      { chunk: mkChunk('r2', 11, 'Ticket still pending review.', { ts: 'pending' }), embedding: [0.8, 0.2, 0] },
    ]);
    const ids = (await store.searchDense(KB_ID, [1, 0, 0], 10, { ts: { gte: 100 } })).map((h) => h.chunkId);
    expect(ids).toContain('r1'); // numeric ts = 150 matches
    expect(ids).not.toContain('r2'); // string ts is excluded, not a cast error
  });

  it('deleteDocument cascades to its chunks', async () => {
    await store.deleteDocument(DOC_ID);
    const cs = await store.getChunks(['c1', 'c2', 'c3']);
    expect(cs).toEqual([]);
  });
});
