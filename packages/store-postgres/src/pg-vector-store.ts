import * as pg from 'pg';
import type { Pool } from 'pg';
import type {
  Chunk,
  KnowledgeBase,
  MetadataFilter,
  MetadataValue,
  SourceDocument,
  UpsertChunk,
  VectorHit,
  VectorStore,
} from '@lucid-rag/core';
import { SCHEMA_SQL } from './schema';
import { buildMetadataFilter, toVectorLiteral } from './sql';

/** Either a Postgres connection string, or an existing pg Pool to reuse. */
export type PgVectorStoreConfig = string | Pool;

/**
 * Postgres + pgvector implementation of the core {@link VectorStore} contract.
 *
 * Dense (cosine, pgvector), sparse (Postgres full-text), and metadata filtering
 * all live in one database. Beyond the retrieval-focused `VectorStore` methods,
 * it exposes a small knowledge-base / document management surface the ingestion
 * layer needs (foreign keys require the parent rows to exist before chunks are
 * upserted).
 */
export class PgVectorStore implements VectorStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(config: PgVectorStoreConfig) {
    if (typeof config === 'string') {
      this.pool = new pg.Pool({ connectionString: config });
      this.ownsPool = true;
    } else {
      this.pool = config;
      this.ownsPool = false;
    }
  }

  /** Create the extension, tables, and indexes if absent (idempotent). */
  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  /** Close the pool — but only if this store created it. */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  // ── Knowledge base / document management ──
  // (Beyond the VectorStore interface; the ingestion pipeline in Phase 1.2 uses
  //  these. Kept here so the store is self-contained and independently testable.)

  async createKnowledgeBase(kb: {
    id: string;
    name: string;
    embeddingModel: string;
    embeddingDims: number;
  }): Promise<KnowledgeBase> {
    const { rows } = await this.pool.query(
      `INSERT INTO knowledge_base (id, name, embedding_model, embedding_dims)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         embedding_model = EXCLUDED.embedding_model,
         embedding_dims = EXCLUDED.embedding_dims
       RETURNING id, name, embedding_model, embedding_dims, created_at`,
      [kb.id, kb.name, kb.embeddingModel, kb.embeddingDims],
    );
    return rowToKnowledgeBase(rows[0]);
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, embedding_model, embedding_dims, created_at
       FROM knowledge_base WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToKnowledgeBase(rows[0]) : null;
  }

  /** Delete a knowledge base and everything under it (documents + chunks cascade). */
  async deleteKnowledgeBase(id: string): Promise<void> {
    await this.pool.query('DELETE FROM knowledge_base WHERE id = $1', [id]);
  }

  async upsertDocument(doc: {
    id: string;
    knowledgeBaseId: string;
    title: string;
    uri?: string;
    mimeType?: string;
    metadata?: Record<string, MetadataValue>;
  }): Promise<SourceDocument> {
    const { rows } = await this.pool.query(
      `INSERT INTO document (id, knowledge_base_id, title, uri, mime_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         knowledge_base_id = EXCLUDED.knowledge_base_id,
         title = EXCLUDED.title,
         uri = EXCLUDED.uri,
         mime_type = EXCLUDED.mime_type,
         metadata = EXCLUDED.metadata
       RETURNING id, knowledge_base_id, title, uri, mime_type, metadata, created_at`,
      [
        doc.id,
        doc.knowledgeBaseId,
        doc.title,
        doc.uri ?? null,
        doc.mimeType ?? null,
        JSON.stringify(doc.metadata ?? {}),
      ],
    );
    return rowToDocument(rows[0]);
  }

  async getDocument(id: string): Promise<SourceDocument | null> {
    const { rows } = await this.pool.query(
      `SELECT id, knowledge_base_id, title, uri, mime_type, metadata, created_at
       FROM document WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToDocument(rows[0]) : null;
  }

  // ── VectorStore interface ──

  async upsert(chunks: UpsertChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { chunk, embedding } of chunks) {
        await client.query(
          `INSERT INTO chunk (
             id, document_id, knowledge_base_id, chunk_index, text, context,
             embed_text, section, char_start, char_end, token_count, metadata, embedding
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::vector)
           ON CONFLICT (id) DO UPDATE SET
             document_id = EXCLUDED.document_id,
             knowledge_base_id = EXCLUDED.knowledge_base_id,
             chunk_index = EXCLUDED.chunk_index,
             text = EXCLUDED.text,
             context = EXCLUDED.context,
             embed_text = EXCLUDED.embed_text,
             section = EXCLUDED.section,
             char_start = EXCLUDED.char_start,
             char_end = EXCLUDED.char_end,
             token_count = EXCLUDED.token_count,
             metadata = EXCLUDED.metadata,
             embedding = EXCLUDED.embedding`,
          [
            chunk.id,
            chunk.documentId,
            chunk.knowledgeBaseId,
            chunk.index,
            chunk.text,
            chunk.context ?? null,
            chunk.embedText,
            chunk.section ?? null,
            chunk.charStart,
            chunk.charEnd,
            chunk.tokenCount,
            JSON.stringify(chunk.metadata ?? {}),
            toVectorLiteral(embedding),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      // Roll back, but never let a secondary rollback failure mask the real error.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* keep the original error */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async searchDense(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorHit[]> {
    // $1 = query vector, $2 = kb id, then the filter params, then $limit.
    const params: unknown[] = [toVectorLiteral(queryEmbedding), knowledgeBaseId];
    const f = buildMetadataFilter(filter, 3);
    const where = ['knowledge_base_id = $2', 'embedding IS NOT NULL', ...f.clauses].join(' AND ');
    params.push(...f.params);
    const limitIdx = f.nextIndex;
    params.push(k);
    // `<=>` is cosine distance; similarity = 1 - distance.
    const { rows } = await this.pool.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS score
       FROM chunk
       WHERE ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${limitIdx}`,
      params,
    );
    return rows.map((r) => ({ chunkId: r.id as string, score: Number(r.score) }));
  }

  async searchSparse(
    knowledgeBaseId: string,
    query: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<VectorHit[]> {
    // $1 = query text, $2 = kb id, then the filter params, then $limit.
    const params: unknown[] = [query, knowledgeBaseId];
    const f = buildMetadataFilter(filter, 3);
    const where = [
      'knowledge_base_id = $2',
      "tsv @@ websearch_to_tsquery('english', $1)",
      ...f.clauses,
    ].join(' AND ');
    params.push(...f.params);
    const limitIdx = f.nextIndex;
    params.push(k);
    const { rows } = await this.pool.query(
      `SELECT id, ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS score
       FROM chunk
       WHERE ${where}
       ORDER BY score DESC
       LIMIT $${limitIdx}`,
      params,
    );
    return rows.map((r) => ({ chunkId: r.id as string, score: Number(r.score) }));
  }

  async getChunks(chunkIds: string[]): Promise<Chunk[]> {
    if (chunkIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT id, document_id, knowledge_base_id, chunk_index, text, context,
              embed_text, section, char_start, char_end, token_count, metadata
       FROM chunk WHERE id = ANY($1)`,
      [chunkIds],
    );
    const byId = new Map<string, Chunk>();
    for (const r of rows) byId.set(r.id as string, rowToChunk(r));
    // Preserve the caller's requested order; silently drop ids that don't exist.
    return chunkIds.map((id) => byId.get(id)).filter((c): c is Chunk => c !== undefined);
  }

  async deleteDocument(documentId: string): Promise<void> {
    // Chunks cascade via the foreign key.
    await this.pool.query('DELETE FROM document WHERE id = $1', [documentId]);
  }
}

// ── Row → domain mappers ──

function rowToChunk(r: Record<string, unknown>): Chunk {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    knowledgeBaseId: r.knowledge_base_id as string,
    index: r.chunk_index as number,
    text: r.text as string,
    context: (r.context as string | null) ?? undefined,
    embedText: r.embed_text as string,
    section: (r.section as string | null) ?? undefined,
    charStart: r.char_start as number,
    charEnd: r.char_end as number,
    tokenCount: r.token_count as number,
    metadata: (r.metadata as Record<string, MetadataValue>) ?? {},
  };
}

function rowToKnowledgeBase(r: Record<string, unknown>): KnowledgeBase {
  return {
    id: r.id as string,
    name: r.name as string,
    embeddingModel: r.embedding_model as string,
    embeddingDims: r.embedding_dims as number,
    createdAt: toIso(r.created_at),
  };
}

function rowToDocument(r: Record<string, unknown>): SourceDocument {
  return {
    id: r.id as string,
    knowledgeBaseId: r.knowledge_base_id as string,
    title: r.title as string,
    uri: (r.uri as string | null) ?? undefined,
    mimeType: (r.mime_type as string | null) ?? undefined,
    metadata: (r.metadata as Record<string, MetadataValue>) ?? {},
    createdAt: toIso(r.created_at),
  };
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
