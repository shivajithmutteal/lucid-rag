/**
 * Provider contracts — the model-agnostic seams. Every model (embeddings,
 * generation, reranking) sits behind one of these, so lucid-rag runs fully local
 * or on any hosted provider by swapping the implementation, not the pipeline.
 *
 * `EmbeddingProvider` and `GenerationProvider` mirror the interfaces in
 * `rag-glassbox` so concepts stay consistent across the two repos. `Reranker` is
 * new here (it's a Tier-A upgrade the demo doesn't need).
 */

/** Turns text into vectors for dense retrieval. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  /** Output vector dimensionality (must match the knowledge base). */
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface GenerateInput {
  /** System / grounding instruction. */
  system?: string;
  /** The user prompt (question + retrieved context). */
  prompt: string;
  maxTokens?: number;
  /** Called with each streamed token delta, if the provider streams. */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Produces the final answer from a grounded prompt. */
export interface GenerationProvider {
  readonly id: string;
  readonly model: string;
  generate(input: GenerateInput): Promise<string>;
}

/** One rerank score for a candidate document. */
export interface RerankResult {
  /** Index into the `documents` array passed to `rerank()`. */
  index: number;
  /** Relevance score; higher is better (absolute scale is reranker-specific). */
  score: number;
}

/**
 * Re-scores candidate documents against the query with a cross-encoder — the
 * single highest-ROI accuracy upgrade after hybrid retrieval. Given many cheap
 * candidates, it returns the best few, properly ordered.
 */
export interface Reranker {
  readonly id: string;
  readonly model: string;
  /** Re-score `documents` against `query`; returns results sorted best-first. */
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}
