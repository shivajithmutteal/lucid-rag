/**
 * Grounded generation (Phase 1.4): turn a retrieval trace into a cited answer.
 *
 *   build numbered-source prompt → generate (streaming) → extract [n] citations
 *     → [optional] faithfulness check → Answer
 *
 * The answer only uses the retrieved sources, cites every claim, and says "I
 * don't know" when the sources don't cover the question. The exact prompt and
 * the trace ride along on the returned Answer, keeping generation see-through.
 */
import type { GenerationProvider } from './providers';
import type { Answer, Citation, FaithfulnessReport, RetrievalTrace, ScoredChunk } from './types';
import { checkFaithfulness } from './faithfulness';

export const ANSWER_SYSTEM =
  'You answer questions strictly and only from the provided numbered sources. ' +
  'Cite every claim with its source number in square brackets — e.g. [1] or [2][3]. ' +
  'If the sources do not contain the answer, say you do not know; never use outside ' +
  'knowledge and never guess.';

const NO_SOURCES = "I don't know — no relevant sources were found for this question.";

/** Build the grounded user prompt: numbered sources followed by the question. */
export function buildAnswerPrompt(query: string, sources: ScoredChunk[]): string {
  const blocks = sources.map((s, i) => {
    const heading = s.chunk.section ? `${s.chunk.section}\n` : '';
    return `[${i + 1}] ${heading}${s.chunk.text}`;
  });
  return `Sources:\n${blocks.join('\n\n')}\n\nQuestion: ${query}\n\nAnswer (cite sources with [n]):`;
}

/** Deterministically extract the in-range [n] citations the answer references. */
export function extractCitations(text: string, sources: ScoredChunk[]): Citation[] {
  const seen = new Map<number, Citation>();
  // Drop fenced/inline code so tokens like `data[2]`, regex, and globs can't
  // masquerade as citation markers.
  const cleaned = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  // Citation position only: the marker must not be glued to an identifier
  // (arr[2], matrix[1]). The negative lookbehind still allows grouped citations
  // like [1][2] (the 2nd '[' is preceded by ']', not a word char).
  const re = /(?<![A-Za-z0-9_])\[([\d\s,]+)\]/g; // handles [1], [1,2], [1 2], [1][2]
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    for (const part of m[1].split(/[\s,]+/).filter(Boolean)) {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= sources.length && !seen.has(n)) {
        const chunk = sources[n - 1].chunk;
        seen.set(n, { n, chunkId: chunk.id, documentId: chunk.documentId, section: chunk.section });
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.n - b.n);
}

export interface AnswerDeps {
  generator: GenerationProvider;
  /** Used for the faithfulness check when `options.checkFaithfulness` is set; defaults to `generator`. */
  faithfulnessChecker?: GenerationProvider;
}

export interface AnswerOptions {
  maxTokens?: number;
  /** Run the faithfulness check after generation. */
  checkFaithfulness?: boolean;
  /** Fraction of claims that must be supported to pass. Default 0.8. */
  faithfulnessThreshold?: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

export async function answerQuestion(
  trace: RetrievalTrace,
  deps: AnswerDeps,
  options: AnswerOptions = {},
): Promise<Answer> {
  const sources = trace.results;
  const prompt = buildAnswerPrompt(trace.query, sources);
  const fullPrompt = `${ANSWER_SYSTEM}\n\n${prompt}`;

  // Nothing to ground on → honest, deterministic answer with no LLM call.
  if (sources.length === 0) {
    return { text: NO_SOURCES, citations: [], prompt: fullPrompt, trace };
  }

  options.signal?.throwIfAborted();
  const raw = await deps.generator.generate({
    system: ANSWER_SYSTEM,
    prompt,
    maxTokens: options.maxTokens,
    onToken: options.onToken,
    signal: options.signal,
  });
  const text = raw.trim();
  const citations = extractCitations(text, sources);

  let faithfulness: FaithfulnessReport | undefined;
  if (options.checkFaithfulness) {
    faithfulness = await checkFaithfulness(text, sources, deps.faithfulnessChecker ?? deps.generator, {
      threshold: options.faithfulnessThreshold,
      signal: options.signal,
    });
  }

  return { text, citations, prompt: fullPrompt, trace, faithfulness };
}
