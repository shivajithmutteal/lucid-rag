/**
 * Ingestion pipeline (Phase 1.2): a document goes from raw text to indexed,
 * searchable chunks.
 *
 *   check KB compatibility → chunk → [contextualize] → build → embed → validate
 *     → (mutate store last) ensure KB → replace → upsert document → index
 *
 * All fallible work (LLM contextualization, embedding, validation) happens
 * BEFORE any destructive store mutation, so a transient failure can never wipe a
 * document's already-indexed chunks. Everything is injected — chunker is pure;
 * embedder, optional generator, and store are the caller's — so the pipeline
 * stays provider- and database-agnostic.
 */
import type { EmbeddingProvider, GenerationProvider } from './providers';
import type { Chunk, MetadataValue } from './types';
import type { DocumentStore, UpsertChunk, VectorStore } from './vector-store';
import { chunkDocument, type ChunkOptions } from './chunk';
import { contextualizeChunks } from './contextualize';

export interface IngestInput {
  /** The knowledge base to ingest into; its embedding model/dims are pinned to `deps.embedder`. */
  knowledgeBase: { id: string; name: string };
  document: {
    id: string;
    title: string;
    uri?: string;
    mimeType?: string;
    /** Inherited onto every chunk, so retrieval-time metadata filters work per chunk. */
    metadata?: Record<string, MetadataValue>;
  };
  /** The document's full text (already parsed/extracted). */
  text: string;
}

export interface IngestOptions {
  chunk?: ChunkOptions;
  /** Generate a situating context per chunk (contextual retrieval). Requires `deps.generator`. */
  contextualize?: boolean;
  /** Concurrency for contextualization calls. Default 4. */
  concurrency?: number;
  /** Replace the document's existing chunks first, for idempotent re-ingest. Default true. */
  replace?: boolean;
  /** Cancels the ingest; checked before any store mutation and before embedding. */
  signal?: AbortSignal;
}

export interface IngestDeps {
  store: VectorStore & DocumentStore;
  embedder: EmbeddingProvider;
  /** Required only when `options.contextualize` is true. */
  generator?: GenerationProvider;
}

export interface IngestResult {
  knowledgeBaseId: string;
  documentId: string;
  chunks: Chunk[];
  chunkCount: number;
  contextualized: boolean;
}

export async function ingestDocument(
  input: IngestInput,
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { store, embedder, generator } = deps;
  const contextualize = options.contextualize ?? false;
  if (contextualize && !generator) {
    throw new Error('ingestDocument: contextualize=true requires deps.generator');
  }
  options.signal?.throwIfAborted();

  // Refuse to re-ingest into a KB pinned to a different embedder — mixing models
  // puts incompatible vector dimensions in one KB and breaks dense search.
  const existingKb = await store.getKnowledgeBase(input.knowledgeBase.id);
  if (
    existingKb &&
    (existingKb.embeddingModel !== embedder.model || existingKb.embeddingDims !== embedder.dims)
  ) {
    throw new Error(
      `ingestDocument: knowledge base '${input.knowledgeBase.id}' is pinned to ` +
        `${existingKb.embeddingModel} (${existingKb.embeddingDims}d) but deps.embedder is ` +
        `${embedder.model} (${embedder.dims}d). Re-embedding a KB with a different model corrupts ` +
        `dense search; use a new knowledge base id or delete the existing one first.`,
    );
  }

  // ── All fallible computation first (no store mutation yet) ──
  const drafts = chunkDocument(input.text, options.chunk);
  const docMeta = input.document.metadata ?? {};
  let chunks: Chunk[] = [];
  let embeddings: number[][] = [];

  if (drafts.length > 0) {
    let contexts: (string | undefined)[] = drafts.map(() => undefined);
    if (contextualize && generator) {
      contexts = await contextualizeChunks(
        input.text,
        drafts.map((d) => d.text),
        generator,
        { concurrency: options.concurrency, signal: options.signal },
      );
    }

    chunks = drafts.map((d, i) => {
      const context = contexts[i];
      return {
        id: `${input.document.id}#${d.index}`,
        documentId: input.document.id,
        knowledgeBaseId: input.knowledgeBase.id,
        index: d.index,
        text: d.text,
        context,
        embedText: context ? `${context}\n\n${d.text}` : d.text,
        section: d.section,
        charStart: d.charStart,
        charEnd: d.charEnd,
        tokenCount: d.tokenCount,
        metadata: { ...docMeta },
      };
    });

    options.signal?.throwIfAborted();
    embeddings = await embedder.embed(chunks.map((c) => c.embedText));
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `ingestDocument: embedder returned ${embeddings.length} vectors for ${chunks.length} chunks`,
      );
    }
    const badDim = embeddings.findIndex((v) => v.length !== embedder.dims);
    if (badDim !== -1) {
      throw new Error(
        `ingestDocument: embedder returned a ${embeddings[badDim].length}-dim vector at index ` +
          `${badDim}, expected ${embedder.dims} (the knowledge base is pinned to ${embedder.dims} dims)`,
      );
    }
  }

  // ── Mutate the store last, once everything above has succeeded ──
  options.signal?.throwIfAborted();
  await store.createKnowledgeBase({
    id: input.knowledgeBase.id,
    name: input.knowledgeBase.name,
    embeddingModel: embedder.model,
    embeddingDims: embedder.dims,
  });
  if (options.replace ?? true) {
    await store.deleteDocument(input.document.id);
  }
  await store.upsertDocument({
    id: input.document.id,
    knowledgeBaseId: input.knowledgeBase.id,
    title: input.document.title,
    uri: input.document.uri,
    mimeType: input.document.mimeType,
    metadata: input.document.metadata,
  });
  if (chunks.length > 0) {
    const upserts: UpsertChunk[] = chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] }));
    await store.upsert(upserts);
  }

  return {
    knowledgeBaseId: input.knowledgeBase.id,
    documentId: input.document.id,
    chunks,
    chunkCount: chunks.length,
    contextualized: chunks.length > 0 ? contextualize : false,
  };
}
