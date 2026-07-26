import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/openai-compat';
import {
  OpenAICompatEmbeddingProvider,
  OpenAICompatGenerationProvider,
  buildChatBody,
  buildEmbeddingBody,
  deltaFromChunk,
  parseEmbeddingResponse,
  textFromCompletion,
} from '../src/openai-compat';

describe('pure helpers', () => {
  it('buildEmbeddingBody', () => {
    expect(JSON.parse(buildEmbeddingBody('m', ['a', 'b']))).toEqual({ model: 'm', input: ['a', 'b'] });
  });

  it('parseEmbeddingResponse orders by index when present', () => {
    expect(
      parseEmbeddingResponse({ data: [{ embedding: [2], index: 1 }, { embedding: [1], index: 0 }] }),
    ).toEqual([[1], [2]]);
  });

  it('parseEmbeddingResponse keeps order when no index', () => {
    expect(parseEmbeddingResponse({ data: [{ embedding: [1] }, { embedding: [2] }] })).toEqual([[1], [2]]);
  });

  it('buildChatBody builds system+user messages, max_tokens, and stream flag', () => {
    const body = JSON.parse(buildChatBody({ system: 'sys', prompt: 'hi', maxTokens: 10 }, 'm', true));
    expect(body).toEqual({
      model: 'm',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 10,
    });
  });

  it('buildChatBody omits the system message when absent', () => {
    const body = JSON.parse(buildChatBody({ prompt: 'hi' }, 'm', false));
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBeUndefined();
  });

  it('deltaFromChunk / textFromCompletion extract content', () => {
    expect(deltaFromChunk({ choices: [{ delta: { content: 'x' } }] })).toBe('x');
    expect(deltaFromChunk({ choices: [{ delta: {} }] })).toBe('');
    expect(textFromCompletion({ choices: [{ message: { content: 'full' } }] })).toBe('full');
  });
});

describe('OpenAICompatEmbeddingProvider', () => {
  it('POSTs to /embeddings and returns vectors in order', async () => {
    let captured: { url: string; body: unknown; auth?: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = {
        url,
        body: JSON.parse(init!.body as string),
        auth: (init!.headers as Record<string, string>).authorization,
      };
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2], index: 0 }, { embedding: [3, 4], index: 1 }] }), { status: 200 });
    };
    const emb = new OpenAICompatEmbeddingProvider({ id: 'x', model: 'm', dims: 2, baseUrl: 'http://x/v1/', apiKey: 'k', fetchImpl });
    expect(await emb.embed(['a', 'b'])).toEqual([[1, 2], [3, 4]]);
    expect(captured?.url).toBe('http://x/v1/embeddings'); // trailing slash trimmed
    expect(captured?.body).toEqual({ model: 'm', input: ['a', 'b'] });
    expect(captured?.auth).toBe('Bearer k');
  });

  it('throws on a vector-count mismatch and returns [] for empty input', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    const emb = new OpenAICompatEmbeddingProvider({ id: 'x', model: 'm', dims: 1, baseUrl: 'http://x/v1', fetchImpl });
    await expect(emb.embed(['a', 'b'])).rejects.toThrow(/1 vectors for 2/);
    expect(await emb.embed([])).toEqual([]);
  });
});

describe('OpenAICompatGenerationProvider', () => {
  it('returns the full text when not streaming', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Full answer.' } }] }), { status: 200 });
    const gen = new OpenAICompatGenerationProvider({ id: 'x', model: 'm', baseUrl: 'http://x/v1', fetchImpl });
    expect(await gen.generate({ prompt: 'hi' })).toBe('Full answer.');
  });

  it('streams token deltas over SSE when onToken is given', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: [DONE]\n\n';
    const fetchImpl: FetchLike = async () => new Response(sse, { status: 200 });
    const gen = new OpenAICompatGenerationProvider({ id: 'x', model: 'm', baseUrl: 'http://x/v1', fetchImpl });
    let streamed = '';
    const out = await gen.generate({ prompt: 'hi', onToken: (d) => (streamed += d) });
    expect(out).toBe('Hello');
    expect(streamed).toBe('Hello');
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 429 });
    const gen = new OpenAICompatGenerationProvider({ id: 'x', model: 'm', baseUrl: 'http://x/v1', fetchImpl });
    await expect(gen.generate({ prompt: 'hi' })).rejects.toThrow(/429/);
  });
});
