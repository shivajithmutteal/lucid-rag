import { describe, expect, it } from 'vitest';
import type { Chunk } from '@lucid-rag/core';
import { HttpError } from '../src/lib/http';
import { handleAsk, parseAskRequest } from '../src/lib/ask';
import { FakeEmbedder, FakeGenerator, FakeStore } from './fakes';

function chunk(id: string, text: string): Chunk {
  return {
    id, documentId: 'd', knowledgeBaseId: 'kb1', index: 0,
    text, embedText: text, charStart: 0, charEnd: text.length, tokenCount: 3, metadata: {},
  };
}

describe('parseAskRequest', () => {
  it('defaults params and requires knowledgeBaseId + query', () => {
    const r = parseAskRequest({ knowledgeBaseId: 'kb1', query: 'q' });
    expect(r.params.mode).toBe('hybrid');
    expect(r.params.topK).toBe(5);
    expect(r.params.candidateK).toBe(20);
    expect(r.checkFaithfulness).toBe(false);
    expect(() => parseAskRequest({ query: 'q' })).toThrow(HttpError);
  });

  it('coerces an invalid mode to hybrid and clamps non-positive k', () => {
    const r = parseAskRequest({ knowledgeBaseId: 'kb1', query: 'q', params: { mode: 'nope', topK: 0 } });
    expect(r.params.mode).toBe('hybrid');
    expect(r.params.topK).toBe(5);
  });
});

describe('handleAsk', () => {
  it('retrieves, answers, streams tokens, and returns citations + trace', async () => {
    const store = new FakeStore();
    store.chunks.set('c1', { chunk: chunk('c1', 'The team has eleven players.'), embedding: [1, 0, 0] });
    store.denseHits = [{ chunkId: 'c1', score: 0.9 }];
    const deps = { store, embedder: new FakeEmbedder(), generator: new FakeGenerator('Eleven players [1].') };

    let streamed = '';
    const ans = await handleAsk(
      { knowledgeBaseId: 'kb1', query: 'how many players?', params: { mode: 'semantic' } },
      deps,
      { onToken: (d) => (streamed += d) },
    );

    expect(ans.text).toBe('Eleven players [1].');
    expect(streamed).toBe('Eleven players [1].');
    expect(ans.citations.map((c) => c.chunkId)).toEqual(['c1']);
    expect(ans.trace.results[0].chunk.id).toBe('c1');
  });

  it('returns an honest "I don\'t know" when nothing is retrieved', async () => {
    const deps = { store: new FakeStore(), embedder: new FakeEmbedder(), generator: new FakeGenerator() };
    const ans = await handleAsk({ knowledgeBaseId: 'kb1', query: 'q', params: { mode: 'semantic' } }, deps);
    expect(ans.text).toMatch(/don't know/i);
    expect(ans.citations).toEqual([]);
  });
});
