import type { Citation, FaithfulnessReport, RetrievalTrace } from '@lucid-rag/core';

export interface AskDone {
  text: string;
  citations: Citation[];
  trace: RetrievalTrace;
  faithfulness?: FaithfulnessReport;
}

export interface AskHandlers {
  onToken?: (delta: string) => void;
  onDone?: (data: AskDone) => void;
  onError?: (data: { status?: number; message: string }) => void;
}

/** POST /api/ask and consume its SSE stream (token / done / error events). */
export async function streamAsk(body: unknown, handlers: AskHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    handlers.onError?.({ message: (err as Error).message });
    return;
  }
  if (!res.ok || !res.body) {
    let message = `request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      /* keep default */
    }
    handlers.onError?.({ status: res.status, message });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        event = 'message';
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        let data: unknown;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event === 'token') handlers.onToken?.(data as string);
        else if (event === 'done') handlers.onDone?.(data as AskDone);
        else if (event === 'error') handlers.onError?.(data as { status?: number; message: string });
      }
    }
  }
}

export interface IngestResult {
  knowledgeBaseId: string;
  documentId: string;
  chunkCount: number;
  contextualized: boolean;
}

/** POST /api/ingest. */
export async function ingestDocument(body: unknown): Promise<IngestResult> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as IngestResult & { error?: string };
  if (!res.ok) throw new Error(json?.error ?? `ingest failed (${res.status})`);
  return json;
}
