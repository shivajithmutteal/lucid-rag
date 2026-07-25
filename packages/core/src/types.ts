/**
 * Core data model for lucid-rag.
 *
 * The centerpiece is {@link RetrievalTrace}: a multi-stage record of what retrieval
 * did — dense candidates, sparse candidates, the fused ranking, the reranker's
 * re-ordering, and the near-misses — so the whole pipeline stays "see-through".
 */

/** A value that can be stored on a document/chunk and filtered on. */
export type MetadataValue = string | number | boolean | null;

/**
 * A retrieval-time filter over chunk/document metadata. Supports equality,
 * membership, and numeric ranges — enough for source/recency/permission filtering.
 * (Dates are typically stored as epoch numbers so they work with gte/lte.)
 */
export type MetadataFilter = {
  [key: string]: MetadataValue | { in: MetadataValue[] } | { gte?: number; lte?: number };
};

/** A collection of documents you search over. Vectors are model-specific, so the
 * embedding model + dimensions are pinned to the knowledge base. */
export interface KnowledgeBase {
  id: string;
  name: string;
  embeddingModel: string;
  embeddingDims: number;
  createdAt: string;
}

/** An ingested source file/page/record. */
export interface SourceDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  /** Original path or URL. */
  uri?: string;
  mimeType?: string;
  /** Arbitrary metadata used for filtering (source, department, date, acl tags…). */
  metadata: Record<string, MetadataValue>;
  createdAt: string;
}

/** A retrieval-sized slice of a document. */
export interface Chunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  index: number;
  /** The chunk's own text — what gets shown to the user and cited. */
  text: string;
  /** Optional situating context generated at ingest (contextual retrieval). */
  context?: string;
  /** The text actually embedded/indexed: `context` (if any) prepended to `text`. */
  embedText: string;
  /** Heading path this chunk lives under, e.g. "Policies > Leave". */
  section?: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  metadata: Record<string, MetadataValue>;
}

/** Which retrieval signal(s) to rank by before reranking. */
export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid';

export interface RetrievalParams {
  mode: RetrievalMode;
  /** How many candidates to pull from each retriever before fusion/rerank. */
  candidateK: number;
  /** How many chunks survive to the answer. */
  topK: number;
  /** Hybrid fusion weight for the semantic signal (0..1); keyword weight is 1 − this. */
  semanticWeight?: number;
  /** Run a cross-encoder rerank over the fused candidates. */
  rerank?: boolean;
  /** How many near-misses (just below topK) to keep in the trace. Default 3. */
  nearMissCount?: number;
  /** Metadata / permission filter applied at retrieval time. */
  filter?: MetadataFilter;
}

/** A chunk with the scores it earned at each stage. Fields are populated as the
 * pipeline runs, so the trace can show exactly how a chunk rose or fell. */
export interface ScoredChunk {
  chunk: Chunk;
  /** Vector (cosine) similarity, if dense retrieval ran. */
  denseScore?: number;
  /** Sparse/keyword (e.g. BM25 / full-text) score, if sparse retrieval ran. */
  sparseScore?: number;
  /** Combined score after hybrid fusion, normalized 0..1. */
  fusedScore?: number;
  /** Cross-encoder relevance score, if reranking ran. */
  rerankScore?: number;
  /** The score used to order this chunk at the current stage. */
  score: number;
  /** 1-based rank at the current stage. */
  rank: number;
}

/** The observable output of retrieval — one entry per pipeline stage, plus timings. */
export interface RetrievalTrace {
  query: string;
  params: RetrievalParams;
  stages: {
    dense?: ScoredChunk[];
    sparse?: ScoredChunk[];
    fused?: ScoredChunk[];
    reranked?: ScoredChunk[];
  };
  /** Final top-k that will feed the answer. */
  results: ScoredChunk[];
  /** The next few chunks just below the cutoff. */
  nearMisses: ScoredChunk[];
  /** Milliseconds spent per stage (dense, sparse, fuse, rerank, …). */
  timings: Record<string, number>;
}

/** A reference from a claim in the answer back to a source chunk. */
export interface Citation {
  /** The bracketed marker used in the answer, e.g. 1 for "[1]". */
  n: number;
  chunkId: string;
  documentId: string;
  section?: string;
}

/** Result of checking that the answer is supported by the retrieved sources. */
export interface FaithfulnessReport {
  /** Fraction of the answer's claims supported by the sources (0..1). */
  score: number;
  /** True when `score` is above the configured threshold. */
  supported: boolean;
  /** Claims that couldn't be traced to a source (potential hallucinations). */
  unsupportedClaims: string[];
}

/** The full result of answering a question. */
export interface Answer {
  text: string;
  citations: Citation[];
  /** The exact prompt sent to the generation model (kept for the glass box). */
  prompt: string;
  trace: RetrievalTrace;
  faithfulness?: FaithfulnessReport;
}

// ── Evaluation (Phase 1.5) ──

export interface EvalSample {
  question: string;
  /** A reference answer, if you have one. */
  groundTruth?: string;
  /** Chunk ids that *should* be retrieved, if you have labels. */
  expectedChunkIds?: string[];
}

export interface EvalScores {
  /** Of the retrieved chunks, how many are relevant. */
  contextPrecision?: number;
  /** Of the relevant chunks, how many were retrieved. */
  contextRecall?: number;
  /** How well the answer is grounded in the retrieved context. */
  faithfulness?: number;
  /** How relevant the answer is to the question. */
  answerRelevance?: number;
}

export interface EvalResult {
  sample: EvalSample;
  answer: Answer;
  scores: EvalScores;
}
