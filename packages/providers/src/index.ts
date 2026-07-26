/**
 * @lucid-rag/providers — concrete provider adapters for the core interfaces.
 * Phase 1.6a: OpenAI-compatible embeddings + generation, resolved from env.
 */
export {
  OpenAICompatEmbeddingProvider,
  OpenAICompatGenerationProvider,
  buildEmbeddingBody,
  parseEmbeddingResponse,
  buildChatBody,
  deltaFromChunk,
  textFromCompletion,
} from './openai-compat';
export type { OpenAICompatConfig, EmbeddingConfig, FetchLike } from './openai-compat';

export { resolveEmbedder, resolveGenerator } from './resolve';
export type { Env } from './resolve';
