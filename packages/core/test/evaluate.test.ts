import { describe, expect, it } from 'vitest';
import type { Answer, Chunk, EvalSample, RetrievalTrace, ScoredChunk } from '../src/types';
import { evaluate } from '../src/evaluate';

function chunk(id: string): Chunk {
  return {
    id, documentId: 'd', knowledgeBaseId: 'kb', index: 0,
    text: `text ${id}`, embedText: 'x', charStart: 0, charEnd: 1, tokenCount: 1, metadata: {},
  };
}

function trace(query: string, ids: string[]): RetrievalTrace {
  const results: ScoredChunk[] = ids.map((id, i) => ({ chunk: chunk(id), score: 1 - i * 0.1, rank: i + 1 }));
  return {
    query,
    params: { mode: 'hybrid', candidateK: 10, topK: ids.length },
    stages: { fused: results },
    results,
    nearMisses: [],
    timings: {},
  };
}

function answer(query: string, ids: string[], faithfulnessScore?: number): Answer {
  return {
    text: 'some answer',
    citations: [],
    prompt: 'p',
    trace: trace(query, ids),
    faithfulness:
      faithfulnessScore === undefined
        ? undefined
        : { score: faithfulnessScore, supported: faithfulnessScore >= 0.8, unsupportedClaims: [] },
  };
}

describe('evaluate', () => {
  it('scores label-based precision/recall and reuses an existing faithfulness report', async () => {
    const samples: EvalSample[] = [
      { question: 'q1', expectedChunkIds: ['a', 'c'] },
      { question: 'q2', expectedChunkIds: ['x'] },
    ];
    const answers: Record<string, Answer> = {
      q1: answer('q1', ['a', 'b', 'c'], 0.9),
      q2: answer('q2', ['y', 'z'], 0.5),
    };

    const report = await evaluate(samples, async (s) => answers[s.question]);

    expect(report.results[0].scores.contextPrecision).toBeCloseTo((1 / 1 + 2 / 3) / 2, 6);
    expect(report.results[0].scores.contextRecall).toBe(1);
    expect(report.results[0].scores.faithfulness).toBe(0.9);
    expect(report.results[1].scores.contextRecall).toBe(0); // 'x' not retrieved

    // Aggregate = mean over the samples where each metric was computed.
    expect(report.aggregate.faithfulness).toBeCloseTo((0.9 + 0.5) / 2, 6);
    expect(report.aggregate.contextRecall).toBeCloseTo((1 + 0) / 2, 6);
  });

  it('omits metrics that cannot be computed and never counts them as zero', async () => {
    const samples: EvalSample[] = [{ question: 'q' }]; // no labels, no report, no deps
    const report = await evaluate(samples, async () => answer('q', ['a']));
    expect(report.results[0].scores.contextPrecision).toBeUndefined();
    expect(report.results[0].scores.faithfulness).toBeUndefined();
    expect(report.aggregate).toEqual({});
  });

  it('computes faithfulness even when retrieval returned no sources', async () => {
    const ans = answer('q', []); // empty trace.results, no prior report
    ans.text = 'A confident but unsupported claim.';
    const generator = { id: 'c', model: 'c', async generate() { return '{"claims":[{"text":"x","supported":false}]}'; } };
    const report = await evaluate([{ question: 'q' }], async () => ans, { generator });
    expect(report.results[0].scores.faithfulness).toBe(0); // computed (not omitted) — flags the hallucination
  });

  it('surfaces the computed faithfulness report so the threshold is observable', async () => {
    const ans = answer('q', ['a']); // no prior report
    const generator = {
      id: 'c', model: 'c',
      async generate() { return '{"claims":[{"text":"x","supported":true},{"text":"y","supported":false}]}'; },
    };
    const report = await evaluate([{ question: 'q' }], async () => ans, { generator }, { faithfulnessThreshold: 0.9 });
    expect(report.results[0].scores.faithfulness).toBe(0.5);
    expect(report.results[0].answer.faithfulness?.supported).toBe(false); // 0.5 < 0.9
  });
});
