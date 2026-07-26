import type {
  Chunk,
  DocumentInput,
  DocumentStore,
  EmbeddingProvider,
  GenerateInput,
  GenerationProvider,
  KnowledgeBase,
  KnowledgeBaseInput,
  SourceDocument,
  UpsertChunk,
  VectorHit,
  VectorStore,
} from '@lucid-rag/core';

const NOW = '2026-01-01T00:00:00.000Z';

/** In-memory VectorStore + DocumentStore for handler tests. */
export class FakeStore implements VectorStore, DocumentStore {
  kbs = new Map<string, KnowledgeBase>();
  docs = new Map<string, SourceDocument>();
  chunks = new Map<string, UpsertChunk>();
  denseHits: VectorHit[] = [];
  sparseHits: VectorHit[] = [];

  async createKnowledgeBase(kb: KnowledgeBaseInput): Promise<KnowledgeBase> {
    const full: KnowledgeBase = { ...kb, createdAt: NOW };
    this.kbs.set(kb.id, full);
    return full;
  }
  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    return this.kbs.get(id) ?? null;
  }
  async deleteKnowledgeBase(id: string): Promise<void> {
    this.kbs.delete(id);
  }
  async upsertDocument(doc: DocumentInput): Promise<SourceDocument> {
    const full: SourceDocument = {
      id: doc.id,
      knowledgeBaseId: doc.knowledgeBaseId,
      title: doc.title,
      uri: doc.uri,
      mimeType: doc.mimeType,
      metadata: doc.metadata ?? {},
      createdAt: NOW,
    };
    this.docs.set(doc.id, full);
    return full;
  }
  async getDocument(id: string): Promise<SourceDocument | null> {
    return this.docs.get(id) ?? null;
  }
  async upsert(chunks: UpsertChunk[]): Promise<void> {
    for (const c of chunks) this.chunks.set(c.chunk.id, c);
  }
  async searchDense(): Promise<VectorHit[]> {
    return this.denseHits;
  }
  async searchSparse(): Promise<VectorHit[]> {
    return this.sparseHits;
  }
  async getChunks(ids: string[]): Promise<Chunk[]> {
    return ids.map((id) => this.chunks.get(id)?.chunk).filter((c): c is Chunk => !!c);
  }
  async deleteDocument(id: string): Promise<void> {
    this.docs.delete(id);
    for (const [key, v] of this.chunks) if (v.chunk.documentId === id) this.chunks.delete(key);
  }
}

export class FakeEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-embed';
  readonly dims = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((_, i) => [i + 1, 0, 0]);
  }
}

export class FakeGenerator implements GenerationProvider {
  readonly id = 'fake';
  readonly model = 'fake-gen';
  constructor(private response = 'Answer text [1].') {}
  async generate(input: GenerateInput): Promise<string> {
    if (input.onToken) for (const ch of this.response) input.onToken(ch);
    return this.response;
  }
}
