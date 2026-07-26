/**
 * OpenAI-compatible provider adapters. One shape covers many providers by
 * swapping baseUrl + model + apiKey:
 *   embeddings   → OpenAI, Voyage, Ollama (/v1)
 *   generation   → OpenAI, Groq, Gemini (OpenAI-compat), OpenRouter, Ollama
 *
 * `fetch` is injectable so the request/response logic is unit-testable with no
 * network. Pure body-builders and response parsers are exported for the same
 * reason.
 */
import type { EmbeddingProvider, GenerateInput, GenerationProvider } from '@lucid-rag/core';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatConfig {
  id: string;
  model: string;
  /** Base URL up to and including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}

export interface EmbeddingConfig extends OpenAICompatConfig {
  dims: number;
}

// ── Pure helpers ──

export function buildEmbeddingBody(model: string, texts: string[]): string {
  return JSON.stringify({ model, input: texts });
}

/** Extract vectors from an OpenAI-shaped embeddings response, in input order. */
export function parseEmbeddingResponse(json: unknown): number[][] {
  const data = (json as { data?: { embedding: number[]; index?: number }[] }).data;
  if (!Array.isArray(data)) throw new Error('embeddings: response has no data[]');
  const indexed = data.every((d) => typeof d.index === 'number');
  const ordered = indexed ? [...data].sort((a, b) => (a.index as number) - (b.index as number)) : data;
  return ordered.map((d) => d.embedding);
}

export function buildChatBody(input: GenerateInput, model: string, stream: boolean): string {
  const messages: { role: string; content: string }[] = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });
  const body: Record<string, unknown> = { model, messages, stream };
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  return JSON.stringify(body);
}

/** Text delta from one streamed chat.completion.chunk. */
export function deltaFromChunk(json: unknown): string {
  const choice = (json as { choices?: { delta?: { content?: string } }[] }).choices?.[0];
  return choice?.delta?.content ?? '';
}

/** Full text from a non-streaming chat completion. */
export function textFromCompletion(json: unknown): string {
  const choice = (json as { choices?: { message?: { content?: string } }[] }).choices?.[0];
  return choice?.message?.content ?? '';
}

// ── Providers ──

function authHeaders(apiKey?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dims: number;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: EmbeddingConfig) {
    this.id = config.id;
    this.model = config.model;
    this.dims = config.dims;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: buildEmbeddingBody(this.model, texts),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${await safeText(res)}`);
    const vectors = parseEmbeddingResponse(await res.json());
    if (vectors.length !== texts.length) {
      throw new Error(`embeddings: got ${vectors.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  }
}

export class OpenAICompatGenerationProvider implements GenerationProvider {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  async generate(input: GenerateInput): Promise<string> {
    const stream = typeof input.onToken === 'function';
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: buildChatBody(input, this.model, stream),
      signal: input.signal,
    });
    if (!res.ok) throw new Error(`chat ${res.status}: ${await safeText(res)}`);
    if (!stream) return textFromCompletion(await res.json());

    let text = '';
    for await (const data of iterateSSE(res)) {
      if (data === '[DONE]') break;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = deltaFromChunk(json);
      if (delta) {
        text += delta;
        input.onToken?.(delta);
      }
    }
    return text;
  }
}

/** Yield each `data:` payload from a fetch Response's SSE body. */
async function* iterateSSE(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
