import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider, GenerationProvider } from '../src/providers';
import { answerRelevance, contextPrecision, contextRecall, cosineSimilarity } from '../src/metrics';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('is 0 when a vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('contextPrecision', () => {
  it('rewards relevant chunks ranked higher (rank-aware AP)', () => {
    const expected = new Set(['a', 'c']);
    const high = contextPrecision(['a', 'b', 'c'], expected); // a@1, c@3
    const low = contextPrecision(['b', 'a', 'c'], expected); // a@2, c@3
    expect(high).toBeCloseTo((1 / 1 + 2 / 3) / 2, 6); // 0.833
    expect(low).toBeCloseTo((1 / 2 + 2 / 3) / 2, 6); // 0.583
    expect(high).toBeGreaterThan(low);
  });
  it('is 0 when nothing was retrieved or nothing is relevant', () => {
    expect(contextPrecision([], new Set(['a']))).toBe(0);
    expect(contextPrecision(['x', 'y'], new Set(['a']))).toBe(0);
  });
});

describe('contextRecall', () => {
  it('is found / expected', () => {
    expect(contextRecall(['a', 'b'], new Set(['a', 'c', 'd']))).toBeCloseTo(1 / 3, 6);
    expect(contextRecall(['a', 'c'], new Set(['a', 'c']))).toBe(1);
  });
});

describe('answerRelevance', () => {
  it('averages cosine of the original question vs the generated questions', async () => {
    const generator: GenerationProvider = {
      id: 'g',
      model: 'g',
      async generate() {
        return '1. how many players?\n2. team size?';
      },
    };
    // Vectors keyed by topic so the generated questions land near the original.
    const embedder: EmbeddingProvider = {
      id: 'e',
      model: 'e',
      dims: 2,
      async embed(texts: string[]) {
        return texts.map((t) => (/player|team|size/i.test(t) ? [1, 0] : [0, 1]));
      },
    };
    const score = await answerRelevance('how many players on a team?', 'Eleven players.', embedder, generator);
    expect(score).toBeCloseTo(1, 6);
  });

  it('is 0 when the generator produces no questions', async () => {
    const generator: GenerationProvider = { id: 'g', model: 'g', async generate() { return '   '; } };
    const embedder: EmbeddingProvider = { id: 'e', model: 'e', dims: 2, async embed(t) { return t.map(() => [1, 0]); } };
    expect(await answerRelevance('q', 'a', embedder, generator)).toBe(0);
  });

  it('does not mangle a generated question that begins with a decimal number', async () => {
    // The marker-stripping must NOT chop "3." off "3.14 …" (that would drop the "3.14").
    const generator: GenerationProvider = {
      id: 'g', model: 'g',
      async generate() { return '3.14 is the value of which constant?'; },
    };
    const embedder: EmbeddingProvider = {
      id: 'e', model: 'e', dims: 2,
      async embed(texts: string[]) { return texts.map((t) => (/3\.14/.test(t) ? [1, 0] : [0, 1])); },
    };
    // Both the original question and the (intact) generated one mention 3.14 → cosine 1.
    const score = await answerRelevance('what constant is 3.14?', 'Pi is about 3.14.', embedder, generator);
    expect(score).toBeCloseTo(1, 6);
  });
});
