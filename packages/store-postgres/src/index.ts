/**
 * @lucid-rag/store-postgres — Postgres + pgvector implementation of the core
 * VectorStore contract (Phase 1.1): dense vector search, sparse full-text
 * search, and metadata filtering in one database.
 */

export { PgVectorStore } from './pg-vector-store';
export type { PgVectorStoreConfig } from './pg-vector-store';
export { SCHEMA_SQL } from './schema';
export { toVectorLiteral, buildMetadataFilter } from './sql';
export type { FilterSql } from './sql';
