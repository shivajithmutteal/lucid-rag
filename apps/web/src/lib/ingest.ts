import { ingestDocument } from '@lucid-rag/core';
import type { IngestDeps, IngestInput, IngestOptions, MetadataValue } from '@lucid-rag/core';
import { HttpError, optionalString, requireString } from './http';

export interface IngestResponse {
  knowledgeBaseId: string;
  documentId: string;
  chunkCount: number;
  contextualized: boolean;
}

/** Validate an ingest request body and run the pipeline. Throws HttpError(400) on bad input. */
export async function handleIngest(
  body: unknown,
  deps: IngestDeps,
  options?: IngestOptions,
): Promise<IngestResponse> {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  const kb = asObject(b.knowledgeBase);
  const doc = asObject(b.document);

  const input: IngestInput = {
    knowledgeBase: {
      id: requireString(kb.id, 'knowledgeBase.id'),
      name: requireString(kb.name, 'knowledgeBase.name'),
    },
    document: {
      id: requireString(doc.id, 'document.id'),
      title: requireString(doc.title, 'document.title'),
      uri: optionalString(doc.uri),
      mimeType: optionalString(doc.mimeType),
      metadata: asObject(doc.metadata) as Record<string, MetadataValue>,
    },
    text: requireString(b.text, 'text'),
  };

  const result = await ingestDocument(input, deps, options);
  return {
    knowledgeBaseId: result.knowledgeBaseId,
    documentId: result.documentId,
    chunkCount: result.chunkCount,
    contextualized: result.contextualized,
  };
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
