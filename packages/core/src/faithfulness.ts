/**
 * Faithfulness check (Tier A): a second LLM pass that verifies an answer is
 * actually supported by its sources — the guard against confident hallucination.
 * The checker decomposes the answer into atomic claims, marks each
 * supported/unsupported, and we score `supported / total`.
 *
 * Two safety rules make this a real guard rather than theater:
 *   - **Fail-closed on unparseable output.** If the checker's response can't be
 *     parsed into claims at all, report unsupported rather than silently pass.
 *   - **Fail-closed per claim.** Never *drop* a malformed claim entry — dropping
 *     shrinks the denominator and can only *raise* the score, which would let a
 *     mangled "unsupported" verdict slip through. Every returned entry is kept;
 *     anything ambiguous is counted as unsupported.
 *
 * A successfully-parsed *empty* claim list is different: an answer that asserts
 * nothing (e.g. an honest "I don't know") can't contradict the sources, so it is
 * vacuously faithful (score 1) — matching the RAGAS convention.
 */
import type { GenerationProvider } from './providers';
import type { FaithfulnessReport, ScoredChunk } from './types';

export const FAITHFULNESS_SYSTEM =
  'You are a strict fact-checker. Judge only whether each claim is supported by ' +
  'the given sources, using no outside knowledge. Respond only with JSON.';

export interface FaithfulnessOptions {
  /** Fraction of claims that must be supported to pass. Default 0.8. */
  threshold?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface ClaimVerdict {
  text: string;
  supported: boolean;
}

/** First brace-balanced `{…}` object in `raw` (string/escape aware), or null.
 * Tolerates trailing notes / a second object / braces inside claim text, which a
 * greedy first-`{`-to-last-`}` match would choke on. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null; // unbalanced
}

/** Coerce a possibly stringified/loose boolean; anything ambiguous → false. */
function coerceSupported(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'supported') return true;
  }
  return false; // null/undefined/"false"/"partial"/number/object → unsupported
}

/** Pull the `claims` array out of a possibly-noisy LLM JSON response. */
export function parseClaimVerdicts(raw: string): ClaimVerdict[] | null {
  const candidate = extractJsonObject(raw);
  if (candidate === null) return null;
  try {
    const obj = JSON.parse(candidate) as { claims?: unknown };
    if (!obj || !Array.isArray(obj.claims)) return null;
    // Keep EVERY entry — never drop a malformed one (that would shrink the
    // denominator and raise the score). Ambiguous verdicts count as unsupported.
    return obj.claims.map((c) => {
      const entry = (c ?? {}) as Record<string, unknown>;
      const text = typeof entry.text === 'string' ? entry.text : '<unparseable claim>';
      return { text, supported: coerceSupported(entry.supported) };
    });
  } catch {
    return null;
  }
}

export async function checkFaithfulness(
  answerText: string,
  sources: ScoredChunk[],
  checker: GenerationProvider,
  options: FaithfulnessOptions = {},
): Promise<FaithfulnessReport> {
  const threshold = options.threshold ?? 0.8;
  const sourcesBlock = sources.map((s, i) => `[${i + 1}] ${s.chunk.text}`).join('\n\n');
  const prompt =
    `Sources:\n${sourcesBlock}\n\n` +
    `Answer to verify:\n${answerText}\n\n` +
    `Break the answer into individual factual claims. For each claim, decide whether it is ` +
    `fully supported by the sources above. Respond ONLY with JSON of the exact form ` +
    `{"claims":[{"text":"<claim>","supported":true|false}]} and nothing else.`;

  options.signal?.throwIfAborted();
  const raw = await checker.generate({
    system: FAITHFULNESS_SYSTEM,
    prompt,
    maxTokens: options.maxTokens ?? 1024,
    signal: options.signal,
  });

  const claims = parseClaimVerdicts(raw);
  if (!claims) {
    // Unparseable checker output — can't verify, so don't green-light (fail-closed).
    return { score: 0, supported: false, unsupportedClaims: [] };
  }
  if (claims.length === 0) {
    // The answer makes no factual claims (e.g. an honest refusal) → vacuously faithful.
    return { score: 1, supported: true, unsupportedClaims: [] };
  }
  const supportedCount = claims.filter((c) => c.supported).length;
  const score = supportedCount / claims.length;
  return {
    score,
    supported: score >= threshold,
    unsupportedClaims: claims.filter((c) => !c.supported).map((c) => c.text),
  };
}
