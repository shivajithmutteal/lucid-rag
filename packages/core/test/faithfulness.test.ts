import { describe, expect, it } from 'vitest';
import type { GenerationProvider } from '../src/providers';
import type { Chunk, ScoredChunk } from '../src/types';
import { checkFaithfulness, parseClaimVerdicts } from '../src/faithfulness';

const SOURCES: ScoredChunk[] = [
  {
    chunk: {
      id: 'a#0', documentId: 'a', knowledgeBaseId: 'kb', index: 0,
      text: 'The team has eleven players.', embedText: 'x',
      charStart: 0, charEnd: 1, tokenCount: 5, metadata: {},
    } satisfies Chunk,
    score: 1,
    rank: 1,
  },
];

const checkerReturning = (response: string): GenerationProvider => ({
  id: 'c',
  model: 'c',
  async generate() {
    return response;
  },
});

describe('parseClaimVerdicts', () => {
  it('parses claims from clean JSON', () => {
    expect(parseClaimVerdicts('{"claims":[{"text":"a","supported":true},{"text":"b","supported":false}]}')).toEqual([
      { text: 'a', supported: true },
      { text: 'b', supported: false },
    ]);
  });

  it('parses JSON embedded in prose / code fences', () => {
    const raw = 'Here you go:\n```json\n{"claims":[{"text":"a","supported":true}]}\n```';
    expect(parseClaimVerdicts(raw)).toEqual([{ text: 'a', supported: true }]);
  });

  it('keeps every claim, coercing a malformed entry to unsupported (never drops)', () => {
    expect(parseClaimVerdicts('{"claims":[{"text":"a","supported":true},{"nope":1}]}')).toEqual([
      { text: 'a', supported: true },
      { text: '<unparseable claim>', supported: false },
    ]);
  });

  it('coerces stringified/loose booleans; anything ambiguous is unsupported', () => {
    expect(
      parseClaimVerdicts(
        '{"claims":[{"text":"a","supported":"true"},{"text":"b","supported":"false"},{"text":"c","supported":"maybe"}]}',
      ),
    ).toEqual([
      { text: 'a', supported: true },
      { text: 'b', supported: false },
      { text: 'c', supported: false },
    ]);
  });

  it('tolerates a trailing note / second brace after the JSON', () => {
    expect(parseClaimVerdicts('{"claims":[{"text":"a","supported":true}]}\n\nNote: sources only {ok}.')).toEqual([
      { text: 'a', supported: true },
    ]);
  });

  it('returns null on non-JSON', () => {
    expect(parseClaimVerdicts('sorry, I cannot help with that')).toBeNull();
  });
});

describe('checkFaithfulness', () => {
  it('scores supported/total and applies the threshold', async () => {
    const checker = checkerReturning(
      '{"claims":[{"text":"a","supported":true},{"text":"b","supported":true},{"text":"c","supported":false}]}',
    );
    const r = await checkFaithfulness('answer', SOURCES, checker, { threshold: 0.8 });
    expect(r.score).toBeCloseTo(2 / 3, 5);
    expect(r.supported).toBe(false); // 0.667 < 0.8
    expect(r.unsupportedClaims).toEqual(['c']);
  });

  it('passes when all claims are supported', async () => {
    const checker = checkerReturning('{"claims":[{"text":"a","supported":true}]}');
    const r = await checkFaithfulness('answer', SOURCES, checker, { threshold: 0.8 });
    expect(r.score).toBe(1);
    expect(r.supported).toBe(true);
    expect(r.unsupportedClaims).toEqual([]);
  });

  it('does not let a malformed claim inflate the score (fail-closed per claim)', async () => {
    // The second claim's quoted "false" must be kept and counted as unsupported.
    const checker = checkerReturning('{"claims":[{"text":"a","supported":true},{"text":"h","supported":"false"}]}');
    const r = await checkFaithfulness('answer', SOURCES, checker, { threshold: 0.8 });
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.supported).toBe(false);
    expect(r.unsupportedClaims).toEqual(['h']);
  });

  it('treats a parsed empty claim list as vacuously faithful', async () => {
    const r = await checkFaithfulness('I do not know.', SOURCES, checkerReturning('{"claims":[]}'), {});
    expect(r.score).toBe(1);
    expect(r.supported).toBe(true);
    expect(r.unsupportedClaims).toEqual([]);
  });

  it('fails closed when the checker output cannot be parsed', async () => {
    const r = await checkFaithfulness('answer', SOURCES, checkerReturning('no json'), {});
    expect(r.score).toBe(0);
    expect(r.supported).toBe(false);
  });
});
