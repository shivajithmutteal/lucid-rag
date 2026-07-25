import { describe, expect, it } from 'vitest';
import type { GenerateInput, GenerationProvider } from '../src/providers';
import { contextualizeChunks } from '../src/contextualize';

describe('contextualizeChunks', () => {
  it('returns one trimmed context per chunk, in input order', async () => {
    const gen: GenerationProvider = {
      id: 'g',
      model: 'g',
      async generate(input: GenerateInput) {
        const n = input.prompt.match(/chunk-(\d+)/)?.[1] ?? '?';
        return `  ctx-${n}  `;
      },
    };
    const out = await contextualizeChunks('doc', ['chunk-0', 'chunk-1', 'chunk-2'], gen);
    expect(out).toEqual(['ctx-0', 'ctx-1', 'ctx-2']);
  });

  it('fails fast: stops dispatching new calls after the first rejection', async () => {
    let calls = 0;
    const gen: GenerationProvider = {
      id: 'g',
      model: 'g',
      async generate(input: GenerateInput) {
        calls++;
        if (input.prompt.includes('chunk-0')) throw new Error('gen boom');
        return 'ctx';
      },
    };
    const chunks = Array.from({ length: 20 }, (_, i) => `chunk-${i}`);
    await expect(contextualizeChunks('doc', chunks, gen, { concurrency: 3 })).rejects.toThrow(/boom/);
    expect(calls).toBeLessThan(chunks.length); // did NOT keep calling for all 20
  });
});
