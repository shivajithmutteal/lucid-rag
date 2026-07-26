/**
 * Evaluation harness (Phase 1.5): score a set of eval samples with RAGAS-style
 * metrics so retrieval/prompt changes can be judged by numbers.
 *
 * The caller supplies `produceAnswer(sample) => Answer` (wiring retrieve →
 * answerQuestion however they like); the harness only *scores* the resulting
 * `Answer` (which carries its `trace`). Every metric is optional — set only when
 * computable — and the aggregate is the mean over the samples where each metric
 * was actually computed, never counting an absent metric as zero.
 */
import type { EmbeddingProvider, GenerationProvider } from './providers';
import type { Answer, EvalResult, EvalSample, EvalScores } from './types';
import { checkFaithfulness } from './faithfulness';
import { answerRelevance, contextPrecision, contextRecall } from './metrics';

export interface EvalDeps {
  /** For answer relevance. */
  embedder?: EmbeddingProvider;
  /** For answer relevance and for faithfulness (when the Answer has no report). */
  generator?: GenerationProvider;
}

export interface EvalOptions {
  /** Questions to generate for answer relevance. Default 3. */
  relevanceQuestions?: number;
  faithfulnessThreshold?: number;
  signal?: AbortSignal;
}

export interface EvalReport {
  results: EvalResult[];
  /** Mean of each metric over the samples where it was computed. */
  aggregate: EvalScores;
}

export async function evaluate(
  samples: EvalSample[],
  produceAnswer: (sample: EvalSample) => Promise<Answer>,
  deps: EvalDeps = {},
  options: EvalOptions = {},
): Promise<EvalReport> {
  const results: EvalResult[] = [];

  for (const sample of samples) {
    options.signal?.throwIfAborted();
    const answer = await produceAnswer(sample);
    let resultAnswer = answer;
    const scores: EvalScores = {};
    const retrievedIds = answer.trace.results.map((r) => r.chunk.id);

    // Context precision/recall — deterministic, from labels.
    if (sample.expectedChunkIds && sample.expectedChunkIds.length > 0) {
      const expected = new Set(sample.expectedChunkIds);
      scores.contextPrecision = contextPrecision(retrievedIds, expected);
      scores.contextRecall = contextRecall(retrievedIds, expected);
    }

    // Faithfulness — reuse the Answer's report, else compute once. Compute even
    // when retrieval returned no chunks: a confident source-less answer is an
    // unsupported hallucination (~0) and an honest refusal is vacuously faithful
    // (1) — both are signal the aggregate must reflect, and the reuse branch
    // already scores such answers. The computed report is surfaced on the result
    // answer so its threshold-dependent `supported` flag is observable.
    if (answer.faithfulness) {
      scores.faithfulness = answer.faithfulness.score;
    } else if (deps.generator) {
      const report = await checkFaithfulness(answer.text, answer.trace.results, deps.generator, {
        threshold: options.faithfulnessThreshold,
        signal: options.signal,
      });
      resultAnswer = { ...answer, faithfulness: report };
      scores.faithfulness = report.score;
    }

    // Answer relevance — needs both an embedder and a generator.
    if (deps.embedder && deps.generator && answer.text.trim().length > 0) {
      scores.answerRelevance = await answerRelevance(
        sample.question,
        answer.text,
        deps.embedder,
        deps.generator,
        options.relevanceQuestions,
        options.signal,
      );
    }

    results.push({ sample, answer: resultAnswer, scores });
  }

  return { results, aggregate: aggregateScores(results.map((r) => r.scores)) };
}

function aggregateScores(all: EvalScores[]): EvalScores {
  const keys = ['contextPrecision', 'contextRecall', 'faithfulness', 'answerRelevance'] as const;
  const agg: EvalScores = {};
  for (const k of keys) {
    const vals = all.map((s) => s[k]).filter((v): v is number => typeof v === 'number');
    if (vals.length > 0) agg[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return agg;
}
