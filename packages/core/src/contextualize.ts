/**
 * Contextual retrieval (Tier A): before embedding, ask an LLM for a short blurb
 * that situates each chunk within its whole document. Prepending that context to
 * the chunk's text sharply improves retrieval of chunks that are ambiguous on
 * their own (pronouns, bare figures, "the above"). The blurb is stored on
 * `Chunk.context` and embedded as part of `Chunk.embedText`.
 */
import type { GenerationProvider } from './providers';

export const CONTEXTUALIZE_INSTRUCTION =
  'Give a short, succinct context to situate this chunk within the overall document, ' +
  'to improve search retrieval of the chunk. Answer only with the context and nothing else.';

export function buildContextualizePrompt(documentText: string, chunkText: string): string {
  return (
    `<document>\n${documentText}\n</document>\n\n` +
    `Here is the chunk we want to situate within the whole document:\n` +
    `<chunk>\n${chunkText}\n</chunk>\n\n` +
    CONTEXTUALIZE_INSTRUCTION
  );
}

export interface ContextualizeOptions {
  /** Output token cap for each blurb. Default 128. */
  maxTokens?: number;
  /** Max concurrent generation calls. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Generate a situating context for each chunk, preserving input order, with
 * bounded concurrency. Fails fast: the first rejection aborts the remaining
 * lanes so no further generation calls are dispatched (and in-flight ones are
 * signalled to cancel), then re-throws to the caller. An external `signal`
 * cancels everything too.
 */
export async function contextualizeChunks(
  documentText: string,
  chunkTexts: string[],
  generator: GenerationProvider,
  options?: ContextualizeOptions,
): Promise<string[]> {
  const maxTokens = options?.maxTokens ?? 128;
  const concurrency = Math.max(1, options?.concurrency ?? 4);
  const results = new Array<string>(chunkTexts.length);
  let next = 0;

  const controller = new AbortController();
  const external = options?.signal;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const worker = async (): Promise<void> => {
    while (next < chunkTexts.length && !controller.signal.aborted) {
      const i = next++;
      const prompt = buildContextualizePrompt(documentText, chunkTexts[i]);
      const out = await generator.generate({ prompt, maxTokens, signal: controller.signal });
      results[i] = out.trim();
    }
  };

  const lanes = Math.min(concurrency, chunkTexts.length);
  try {
    await Promise.all(
      Array.from({ length: lanes }, () =>
        worker().catch((err) => {
          controller.abort(err); // stop sibling lanes from dispatching more work
          throw err; // still reject the batch to the caller
        }),
      ),
    );
  } finally {
    external?.removeEventListener('abort', onExternalAbort);
  }
  return results;
}
