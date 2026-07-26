/**
 * Evaluation metrics (Phase 1.5), RAGAS-style. The label-based ones
 * (context precision/recall, cosine) are pure and LLM-free; answer relevance
 * needs an embedder + generator. Faithfulness reuses the Phase 1.4 check.
 */
import type { EmbeddingProvider, GenerationProvider } from './providers';

/** Cosine similarity of two vectors; 0 if either is all-zeros. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Context precision as rank-aware average precision: the mean of precision@k at
 * each rank where a relevant (expected) chunk appears. Rewards ranking relevant
 * chunks higher. 0 if nothing was retrieved or none of it is relevant.
 */
export function contextPrecision(retrievedIds: string[], expected: Set<string>): number {
  if (retrievedIds.length === 0) return 0;
  let hits = 0;
  let sum = 0;
  retrievedIds.forEach((id, i) => {
    if (expected.has(id)) {
      hits++;
      sum += hits / (i + 1); // precision@(i+1)
    }
  });
  return hits === 0 ? 0 : sum / hits;
}

/** Context recall: fraction of the expected chunks that were retrieved. */
export function contextRecall(retrievedIds: string[], expected: Set<string>): number {
  if (expected.size === 0) return 1; // nothing to recall → vacuously complete
  const retrieved = new Set(retrievedIds);
  let found = 0;
  for (const id of expected) if (retrieved.has(id)) found++;
  return found / expected.size;
}

const QUESTION_SYSTEM =
  'You generate questions that a given answer directly and fully answers. ' +
  'Output one question per line and nothing else.';

/**
 * Answer relevance (RAGAS round-trip): ask the generator for `n` questions the
 * answer would answer, embed them and the original question, and average the
 * cosine similarity. A relevant answer produces questions close to the real one.
 * Returns 0 if the generator produces no usable questions.
 */
export async function answerRelevance(
  question: string,
  answerText: string,
  embedder: EmbeddingProvider,
  generator: GenerationProvider,
  n = 3,
  signal?: AbortSignal,
): Promise<number> {
  const prompt =
    `Given the answer below, write ${n} different questions that this answer ` +
    `directly and completely answers. One question per line, no numbering.\n\n` +
    `Answer:\n${answerText}`;
  signal?.throwIfAborted();
  const raw = await generator.generate({ system: QUESTION_SYSTEM, prompt, maxTokens: 256, signal });
  const questions = raw
    .split('\n')
    // Strip a leading list marker ("1. ", "2) ", "- ", "* ", "• ") ONLY when a
    // space follows it — so a question that legitimately starts with a decimal
    // ("3.14 …") or a negative number ("-5 …") is left intact.
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, n);
  if (questions.length === 0) return 0;

  const vectors = await embedder.embed([question, ...questions]);
  const [q, ...rest] = vectors;
  if (!q || rest.length === 0) return 0;
  const sims = rest.map((v) => cosineSimilarity(q, v));
  return sims.reduce((a, b) => a + b, 0) / sims.length;
}
