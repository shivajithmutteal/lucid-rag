import { describe, expect, it } from 'vitest';
import { resolveEmbedder, resolveGenerator } from '../src/resolve';

describe('resolveEmbedder', () => {
  it('prefers Voyage, then OpenAI, then Ollama (local-first default)', () => {
    expect(resolveEmbedder({ VOYAGE_API_KEY: 'k' }).id).toBe('voyage');
    expect(resolveEmbedder({ VOYAGE_API_KEY: 'k' }).dims).toBe(1024);
    expect(resolveEmbedder({ OPENAI_API_KEY: 'k' }).id).toBe('openai');
    expect(resolveEmbedder({ OPENAI_API_KEY: 'k' }).dims).toBe(1536);
    const local = resolveEmbedder({});
    expect(local.id).toBe('ollama');
    expect(local.dims).toBe(768);
    expect(local.model).toBe('nomic-embed-text');
  });

  it('honors an EMBED_DIMS override for an unknown model', () => {
    expect(resolveEmbedder({ OPENAI_API_KEY: 'k', OPENAI_EMBED_MODEL: 'custom', EMBED_DIMS: '256' }).dims).toBe(256);
  });

  it('throws for an unknown model with no override', () => {
    expect(() => resolveEmbedder({ OPENAI_API_KEY: 'k', OPENAI_EMBED_MODEL: 'mystery' })).toThrow(/dimensions/);
  });
});

describe('resolveGenerator', () => {
  it('prefers OpenAI → Groq → Gemini → OpenRouter → Ollama', () => {
    expect(resolveGenerator({ OPENAI_API_KEY: 'k' }).id).toBe('openai');
    expect(resolveGenerator({ GROQ_API_KEY: 'k' }).id).toBe('groq');
    expect(resolveGenerator({ GEMINI_API_KEY: 'k' }).id).toBe('gemini');
    expect(resolveGenerator({ OPENROUTER_API_KEY: 'k' }).id).toBe('openrouter');
    expect(resolveGenerator({}).id).toBe('ollama');
  });
});
