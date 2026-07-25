import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider, GenerateInput, GenerationProvider } from '../src/providers';
import type { Chunk, KnowledgeBase, SourceDocument } from '../src/types';
import type {
  DocumentInput,
  DocumentStore,
  KnowledgeBaseInput,
  UpsertChunk,
  VectorHit,
  VectorStore,
} from '../src/vector-store';
import { ingestDocument } from '../src/ingest';

class FakeEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-embed';
  readonly dims = 3;
  calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => [t.length, t.split(/\s+/).length, 0]);
  }
}

class FakeGenerator implements GenerationProvider {
  readonly id = 'fake';
  readonly model = 'fake-gen';
  calls = 0;
  async generate(_input: GenerateInput): Promise<string> {
    this.calls++;
    return '  CTX  ';
  }
}

/** Same model/dims as FakeEmbedder, but embed() always throws. */
class FailingEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-embed';
  readonly dims = 3;
  async embed(): Promise<number[][]> {
    throw new Error('embed boom');
  }
}

/** Pinned to 3 dims but returns 2-dim vectors. */
class WrongDimEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-embed';
  readonly dims = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 2]);
  }
}

/** A different model/dims — incompatible with a KB pinned to FakeEmbedder. */
class OtherEmbedder implements EmbeddingProvider {
  readonly id = 'other';
  readonly model = 'other-model';
  readonly dims = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(8).fill(0));
  }
}

/** In-memory VectorStore + DocumentStore for pipeline tests (no database). */
class FakeStore implements VectorStore, DocumentStore {
  kbs = new Map<string, KnowledgeBase>();
  docs = new Map<string, SourceDocument>();
  chunks = new Map<string, { chunk: Chunk; embedding: number[] }>();

  async createKnowledgeBase(kb: KnowledgeBaseInput): Promise<KnowledgeBase> {
    const record: KnowledgeBase = { ...kb, createdAt: '2026-01-01T00:00:00.000Z' };
    this.kbs.set(kb.id, record);
    return record;
  }
  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    return this.kbs.get(id) ?? null;
  }
  async deleteKnowledgeBase(id: string): Promise<void> {
    this.kbs.delete(id);
    for (const [k, v] of this.docs) if (v.knowledgeBaseId === id) this.docs.delete(k);
    for (const [k, v] of this.chunks) if (v.chunk.knowledgeBaseId === id) this.chunks.delete(k);
  }
  async upsertDocument(doc: DocumentInput): Promise<SourceDocument> {
    const record: SourceDocument = {
      id: doc.id,
      knowledgeBaseId: doc.knowledgeBaseId,
      title: doc.title,
      uri: doc.uri,
      mimeType: doc.mimeType,
      metadata: doc.metadata ?? {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    this.docs.set(doc.id, record);
    return record;
  }
  async getDocument(id: string): Promise<SourceDocument | null> {
    return this.docs.get(id) ?? null;
  }
  async upsert(items: UpsertChunk[]): Promise<void> {
    for (const it of items) this.chunks.set(it.chunk.id, { chunk: it.chunk, embedding: it.embedding });
  }
  async searchDense(): Promise<VectorHit[]> {
    return [];
  }
  async searchSparse(): Promise<VectorHit[]> {
    return [];
  }
  async getChunks(ids: string[]): Promise<Chunk[]> {
    return ids.map((id) => this.chunks.get(id)?.chunk).filter((c): c is Chunk => !!c);
  }
  async deleteDocument(documentId: string): Promise<void> {
    this.docs.delete(documentId);
    for (const [k, v] of this.chunks) if (v.chunk.documentId === documentId) this.chunks.delete(k);
  }
}

const TEXT = `# Handbook

## Leave

Employees receive twenty days of annual leave.

## Expenses

Expense reports must be filed within thirty days.
`;

describe('ingestDocument', () => {
  it('creates the KB pinned to the embedder, upserts the document, and indexes chunks', async () => {
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const res = await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'Handbook', metadata: { dept: 'hr' } }, text: TEXT },
      { store, embedder },
    );

    expect(res.chunkCount).toBeGreaterThan(0);
    expect(res.contextualized).toBe(false);
    expect(store.kbs.get('kb1')?.embeddingModel).toBe('fake-embed');
    expect(store.kbs.get('kb1')?.embeddingDims).toBe(3);
    expect(store.docs.get('doc1')?.title).toBe('Handbook');

    const first = res.chunks[0];
    expect(first.id).toBe('doc1#0');
    expect(first.metadata.dept).toBe('hr'); // inherited from the document
    expect(first.embedText).toBe(first.text); // no context prepended
    expect(store.chunks.size).toBe(res.chunkCount);
    // The embedder was fed exactly the chunks' embedText, in order.
    expect(embedder.calls[0]).toEqual(res.chunks.map((c) => c.embedText));
  });

  it('contextualizes when enabled, prepending the (trimmed) context to embedText', async () => {
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const generator = new FakeGenerator();
    const res = await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: TEXT },
      { store, embedder, generator },
      { contextualize: true },
    );

    expect(res.contextualized).toBe(true);
    expect(generator.calls).toBe(res.chunkCount); // one call per chunk
    const first = res.chunks[0];
    expect(first.context).toBe('CTX');
    expect(first.embedText).toBe(`CTX\n\n${first.text}`);
  });

  it('throws if contextualize is requested without a generator', async () => {
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    await expect(
      ingestDocument(
        { knowledgeBase: { id: 'k', name: 'n' }, document: { id: 'd', title: 't' }, text: TEXT },
        { store, embedder },
        { contextualize: true },
      ),
    ).rejects.toThrow(/generator/);
  });

  it('re-ingest replaces prior chunks (no orphans when the document shrinks)', async () => {
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: TEXT },
      { store, embedder },
    );
    const firstCount = store.chunks.size;
    expect(firstCount).toBeGreaterThan(1);

    await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: '# T\n\nShort.' },
      { store, embedder },
    );

    expect([...store.chunks.values()].every((v) => v.chunk.documentId === 'doc1')).toBe(true);
    expect(store.chunks.size).toBe(1); // old chunks gone, only the new one remains
  });

  it('throws when the embedder returns a wrong-dimensionality vector, writing nothing', async () => {
    const store = new FakeStore();
    await expect(
      ingestDocument(
        { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: TEXT },
        { store, embedder: new WrongDimEmbedder() },
      ),
    ).rejects.toThrow(/dim/);
    expect(store.chunks.size).toBe(0);
  });

  it('refuses to re-ingest into a KB pinned to a different embedder', async () => {
    const store = new FakeStore();
    await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'd1', title: 't' }, text: TEXT },
      { store, embedder: new FakeEmbedder() },
    );
    await expect(
      ingestDocument(
        { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'd2', title: 't' }, text: TEXT },
        { store, embedder: new OtherEmbedder() },
      ),
    ).rejects.toThrow(/pinned/);
  });

  it('does not destroy existing chunks when a re-ingest embed fails', async () => {
    const store = new FakeStore();
    await ingestDocument(
      { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: TEXT },
      { store, embedder: new FakeEmbedder() },
    );
    const before = store.chunks.size;
    expect(before).toBeGreaterThan(0);
    await expect(
      ingestDocument(
        { knowledgeBase: { id: 'kb1', name: 'HR' }, document: { id: 'doc1', title: 'H' }, text: TEXT },
        { store, embedder: new FailingEmbedder() },
      ),
    ).rejects.toThrow(/boom/);
    expect(store.chunks.size).toBe(before); // old chunks survive the failed re-ingest
  });

  it('short-circuits on an already-aborted signal without mutating the store', async () => {
    const store = new FakeStore();
    const ac = new AbortController();
    ac.abort();
    await expect(
      ingestDocument(
        { knowledgeBase: { id: 'k', name: 'n' }, document: { id: 'd', title: 't' }, text: TEXT },
        { store, embedder: new FakeEmbedder() },
        { signal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(store.kbs.size).toBe(0);
    expect(store.chunks.size).toBe(0);
  });
});
