/**
 * Dependency-free token estimation for chunk sizing.
 *
 * This is intentionally NOT a real tokenizer — it's a cheap ~4-characters-per-token
 * heuristic, good enough to size chunks. The exact token budget at the model
 * boundary is the provider's concern, not the chunker's.
 */
export function estimateTokens(text: string): number {
  const len = text.trim().length;
  return len === 0 ? 0 : Math.ceil(len / 4);
}
