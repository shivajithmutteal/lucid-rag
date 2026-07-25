/** Public API of the lucid-rag core engine. Phase 1.0: the shared contracts. */

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

export type { UpsertChunk, VectorHit, VectorStore } from './vector-store';
