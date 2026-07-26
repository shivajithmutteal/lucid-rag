/**
 * Resolve concrete providers from environment variables — first key wins,
 * defaulting to local-first Ollama (no key, data stays on the box). Mirrors the
 * precedence in `.env.example`:
 *   embeddings: Voyage → OpenAI → Ollama
 *   generation: OpenAI → Groq → Gemini → OpenRouter → Ollama
 *
 * (Anthropic and rerankers are separate adapters, added in a later sub-phase.)
 */
import type { EmbeddingProvider, GenerationProvider } from '@lucid-rag/core';
import {
  OpenAICompatEmbeddingProvider,
  OpenAICompatGenerationProvider,
  type FetchLike,
} from './openai-compat';

export type Env = Record<string, string | undefined>;

/** Known output dimensionality per embedding model. */
const EMBED_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'voyage-3.5-lite': 1024,
  'voyage-3': 1024,
  'nomic-embed-text': 768,
};

function dimsFor(model: string, env: Env): number {
  if (env.EMBED_DIMS) {
    const n = Number(env.EMBED_DIMS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const known = EMBED_DIMS[model];
  if (known) return known;
  throw new Error(`resolveEmbedder: unknown dimensions for embedding model "${model}"; set EMBED_DIMS`);
}

function trimHost(host: string): string {
  return host.replace(/\/+$/, '');
}

export function resolveEmbedder(env: Env, fetchImpl?: FetchLike): EmbeddingProvider {
  if (env.VOYAGE_API_KEY) {
    const model = env.VOYAGE_EMBED_MODEL ?? 'voyage-3.5-lite';
    return new OpenAICompatEmbeddingProvider({
      id: 'voyage', model, dims: dimsFor(model, env),
      baseUrl: 'https://api.voyageai.com/v1', apiKey: env.VOYAGE_API_KEY, fetchImpl,
    });
  }
  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
    return new OpenAICompatEmbeddingProvider({
      id: 'openai', model, dims: dimsFor(model, env),
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY, fetchImpl,
    });
  }
  const model = env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
  return new OpenAICompatEmbeddingProvider({
    id: 'ollama', model, dims: dimsFor(model, env),
    baseUrl: `${trimHost(env.OLLAMA_HOST ?? 'http://localhost:11434')}/v1`, fetchImpl,
  });
}

export function resolveGenerator(env: Env, fetchImpl?: FetchLike): GenerationProvider {
  const make = (id: string, model: string, baseUrl: string, apiKey?: string): GenerationProvider =>
    new OpenAICompatGenerationProvider({ id, model, baseUrl, apiKey, fetchImpl });

  if (env.OPENAI_API_KEY) {
    return make('openai', env.OPENAI_GEN_MODEL ?? 'gpt-4o-mini', env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', env.OPENAI_API_KEY);
  }
  if (env.GROQ_API_KEY) {
    return make('groq', env.GROQ_GEN_MODEL ?? 'llama-3.3-70b-versatile', 'https://api.groq.com/openai/v1', env.GROQ_API_KEY);
  }
  if (env.GEMINI_API_KEY) {
    return make('gemini', env.GEMINI_GEN_MODEL ?? 'gemini-2.0-flash', 'https://generativelanguage.googleapis.com/v1beta/openai', env.GEMINI_API_KEY);
  }
  if (env.OPENROUTER_API_KEY) {
    return make('openrouter', env.OPENROUTER_GEN_MODEL ?? 'meta-llama/llama-3.3-70b-instruct', 'https://openrouter.ai/api/v1', env.OPENROUTER_API_KEY);
  }
  return make('ollama', env.OLLAMA_GEN_MODEL ?? 'llama3.2', `${trimHost(env.OLLAMA_HOST ?? 'http://localhost:11434')}/v1`);
}
