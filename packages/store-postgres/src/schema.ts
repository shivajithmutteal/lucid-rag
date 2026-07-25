/**
 * Postgres + pgvector schema for lucid-rag (Phase 1.1).
 *
 * One database handles all three retrieval signals plus filtering:
 *   - dense vector search      → the `embedding` column (pgvector, `<=>` cosine)
 *   - sparse / keyword search  → the generated `tsv` tsvector column (full-text)
 *   - metadata / permissions   → the `metadata` jsonb columns
 *
 * `init()` runs this SQL; it is idempotent (IF NOT EXISTS everywhere), so it is
 * safe to call on every startup.
 *
 * ── On the `embedding` column having no fixed dimension ──
 * Each knowledge base pins its own embedding model + dimensionality, and
 * different KBs may use different models. A single `vector(N)` column can't hold
 * mixed dimensions, so the column is an unconstrained `vector`. Dense search is
 * always scoped by `knowledge_base_id`, so every vector compared in a query
 * shares that KB's dimensions — pgvector never sees a dimension mismatch.
 *
 * The tradeoff: an unconstrained `vector` column can't carry a global ANN
 * (HNSW/IVFFlat) index, so search is *exact* KNN — correct at any dimension and
 * plenty fast for a self-host starter. For a large single-model deployment, add
 * a partial HNSW index once the dimension is known, e.g.:
 *
 *   CREATE INDEX chunk_hnsw_1536
 *     ON chunk USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
 *     WHERE knowledge_base_id = '<kb-id>';
 */
export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_base (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dims  integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document (
  id                text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
  title             text NOT NULL,
  uri               text,
  mime_type         text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_kb_idx ON document (knowledge_base_id);

CREATE TABLE IF NOT EXISTS chunk (
  id                text PRIMARY KEY,
  document_id       text NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  knowledge_base_id text NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
  chunk_index       integer NOT NULL,
  text              text NOT NULL,
  context           text,
  embed_text        text NOT NULL,
  section           text,
  char_start        integer NOT NULL,
  char_end          integer NOT NULL,
  token_count       integer NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding         vector,
  tsv               tsvector GENERATED ALWAYS AS (
                      to_tsvector('english', coalesce(section, '') || ' ' || text)
                    ) STORED
);
CREATE INDEX IF NOT EXISTS chunk_kb_idx   ON chunk (knowledge_base_id);
CREATE INDEX IF NOT EXISTS chunk_doc_idx  ON chunk (document_id);
CREATE INDEX IF NOT EXISTS chunk_tsv_idx  ON chunk USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunk_meta_idx ON chunk USING gin (metadata jsonb_path_ops);
`;
