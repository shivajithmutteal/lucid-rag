/**
 * Public API of the lucid-rag core engine.
 *   Phase 1.0 — shared contracts (data model, providers, store, trace).
 *   Phase 1.2 — ingestion: chunking, contextualization, and the pipeline.
 */

export type {
  MetadataValue,
  MetadataFilter,
  KnowledgeBase,
  SourceDocument,
  Chunk,
  RetrievalMode,
  RetrievalParams,
  ScoredChunk,
  RetrievalTrace,
  Citation,
  FaithfulnessReport,
  Answer,
  EvalSample,
  EvalScores,
  EvalResult,
} from './types';

export type {
  EmbeddingProvider,
  GenerateInput,
  GenerationProvider,
  RerankResult,
  Reranker,
} from './providers';

export type {
  UpsertChunk,
  VectorHit,
  VectorStore,
  KnowledgeBaseInput,
  DocumentInput,
  DocumentStore,
} from './vector-store';

// ── Ingestion (Phase 1.2) ──

export { estimateTokens } from './tokenize';
export { chunkDocument } from './chunk';
export type { ChunkDraft, ChunkOptions } from './chunk';
export { contextualizeChunks, buildContextualizePrompt, CONTEXTUALIZE_INSTRUCTION } from './contextualize';
export type { ContextualizeOptions } from './contextualize';
export { ingestDocument } from './ingest';
export type { IngestInput, IngestOptions, IngestDeps, IngestResult } from './ingest';

// ── Retrieval (Phase 1.3) ──

export { retrieve } from './retrieve';
export type { RetrieveDeps } from './retrieve';
