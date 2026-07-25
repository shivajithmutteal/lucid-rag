import type { Chunk, MetadataFilter } from './types';

/**
 * Storage contract. The core engine is DB-agnostic: it orchestrates retrieval
 * through this interface, and the concrete implementation (Postgres + pgvector,
 * in `@lucid-rag/store-postgres`) supplies dense vector search, sparse/full-text search, metadata
 * filtering, and chunk hydration. Swap the store without touching the engine.
 */

export interface UpsertChunk {
  chunk: Chunk;
  /** The chunk's embedding, aligned to the knowledge base's model/dims. */
  embedding: number[];
}

/** A single search hit: which chunk, and its raw score from that retriever. */
export interface VectorHit {
  chunkId: string;
  score: number;
}

export interface VectorStore {
  /** Insert or update chunks (with embeddings). */
  upsert(chunks: UpsertChunk[]): Promise<void>;

  /** Dense (vector) nearest-neighbor search, optionally filtered by metadata. */
  searchDense(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorHit[]>;

  /** Sparse (keyword / full-text) search, optionally filtered by metadata. */
  searchSparse(
    knowledgeBaseId: string,
    query: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorHit[]>;

  /** Fetch full chunk records by id (to hydrate hits into ScoredChunks). */
  getChunks(chunkIds: string[]): Promise<Chunk[]>;

  /** Remove all chunks belonging to a document. */
  deleteDocument(documentId: string): Promise<void>;
}
