import { describe, expect, it } from 'vitest';
import type { GenerateInput, GenerationProvider } from '../src/providers';
import type { Chunk, RetrievalTrace, ScoredChunk } from '../src/types';
import { ANSWER_SYSTEM, answerQuestion, buildAnswerPrompt, extractCitations } from '../src/answer';

const CHUNKS: Chunk[] = [
  {
    id: 'a#0', documentId: 'a', knowledgeBaseId: 'kb', index: 0,
    text: 'The team has eleven players.', embedText: 'x', section: 'Rules',
    charStart: 0, charEnd: 1, tokenCount: 5, metadata: {},
  },
  {
    id: 'a#1', documentId: 'a', knowledgeBaseId: 'kb', index: 1,
    text: 'A match lasts ninety minutes.', embedText: 'x',
    charStart: 0, charEnd: 1, tokenCount: 5, metadata: {},
  },
];

function makeTrace(query: string, chunks: Chunk[]): RetrievalTrace {
  const results: ScoredChunk[] = chunks.map((chunk, i) => ({ chunk, score: 1 - i * 0.1, rank: i + 1 }));
  return {
    query,
    params: { mode: 'hybrid', candidateK: 10, topK: chunks.length },
    stages: { fused: results },
    results,
    nearMisses: [],
    timings: {},
  };
}

class FakeGenerator implements GenerationProvider {
  readonly id = 'g';
  readonly model = 'g';
  lastInput?: GenerateInput;
  constructor(private response = 'A team has eleven players [1].') {}
  async generate(input: GenerateInput): Promise<string> {
    this.lastInput = input;
    if (input.onToken) for (const ch of this.response) input.onToken(ch);
    return this.response;
  }
}

describe('buildAnswerPrompt', () => {
  it('numbers the sources (with section) and includes the question', () => {
    const p = buildAnswerPrompt('why?', makeTrace('q', CHUNKS).results);
    expect(p).toContain('[1] Rules\nThe team has eleven players.');
    expect(p).toContain('[2] A match lasts ninety minutes.');
    expect(p).toContain('Question: why?');
  });
});

describe('extractCitations', () => {
  const sources = makeTrace('q', CHUNKS).results;
  it('parses single/grouped/repeated markers, de-duped and in range', () => {
    expect(extractCitations('foo [1] bar [1,2] baz [2][9]', sources).map((c) => c.n)).toEqual([1, 2]);
  });
  it('maps a marker to the right chunk', () => {
    expect(extractCitations('see [2]', sources)[0].chunkId).toBe('a#1');
  });
  it('returns nothing when there are no markers', () => {
    expect(extractCitations('no citations here', sources)).toEqual([]);
  });

  it('ignores bracketed-digit code/index syntax (no spurious citations)', () => {
    expect(extractCitations('the record is in data[2]; see [1].', sources).map((c) => c.n)).toEqual([1]);
    expect(extractCitations('the record is in `data[2]`; see [1].', sources).map((c) => c.n)).toEqual([1]);
  });

  it('accepts space-separated groups like [1 2]', () => {
    expect(extractCitations('supported by both [1 2].', sources).map((c) => c.n)).toEqual([1, 2]);
  });
});

describe('answerQuestion', () => {
  it('generates a grounded answer with citations, the exact prompt, and the trace', async () => {
    const gen = new FakeGenerator('A team has eleven players [1]. Matches last ninety minutes [2].');
    const trace = makeTrace('players and length?', CHUNKS);
    const ans = await answerQuestion(trace, { generator: gen });
    expect(ans.text).toContain('eleven players');
    expect(ans.citations.map((c) => c.n)).toEqual([1, 2]);
    expect(ans.citations[0].chunkId).toBe('a#0');
    expect(ans.prompt).toContain(ANSWER_SYSTEM);
    expect(ans.prompt).toContain('[1] Rules');
    expect(ans.trace).toBe(trace);
  });

  it('streams tokens through onToken', async () => {
    const gen = new FakeGenerator('Hello [1].');
    let streamed = '';
    await answerQuestion(makeTrace('q', CHUNKS), { generator: gen }, { onToken: (d) => (streamed += d) });
    expect(streamed).toBe('Hello [1].');
  });

  it('short-circuits with an honest answer and no LLM call when there are no sources', async () => {
    let called = false;
    const spy: GenerationProvider = {
      id: 'g', model: 'g',
      async generate() { called = true; return 'x'; },
    };
    const ans = await answerQuestion(makeTrace('q', []), { generator: spy });
    expect(called).toBe(false);
    expect(ans.text).toMatch(/don't know/i);
    expect(ans.citations).toEqual([]);
  });

  it('runs the faithfulness check when requested, using the checker', async () => {
    const gen = new FakeGenerator('Eleven players [1].');
    const checker: GenerationProvider = {
      id: 'c', model: 'c',
      async generate() { return '{"claims":[{"text":"Eleven players","supported":true}]}'; },
    };
    const ans = await answerQuestion(
      makeTrace('q', CHUNKS),
      { generator: gen, faithfulnessChecker: checker },
      { checkFaithfulness: true },
    );
    expect(ans.faithfulness?.supported).toBe(true);
    expect(ans.faithfulness?.score).toBe(1);
  });
});
