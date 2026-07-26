import type { EmbeddingProvider, GenerationProvider } from '@lucid-rag/core';
import { resolveEmbedder, resolveGenerator } from '@lucid-rag/providers';
import { PgVectorStore } from '@lucid-rag/store-postgres';

export interface AppDeps {
  store: PgVectorStore;
  embedder: EmbeddingProvider;
  generator: GenerationProvider;
  /** When true, ingestion is disabled (a locked-down public instance). */
  readOnly: boolean;
}

let cached: AppDeps | undefined;

/** Resolve the store + providers from the environment, memoized for the process. */
export function getDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  if (cached) return cached;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — copy .env.example to .env');
  cached = {
    store: new PgVectorStore(databaseUrl),
    embedder: resolveEmbedder(env),
    generator: resolveGenerator(env),
    readOnly: env.LUCID_READONLY === 'true',
  };
  return cached;
}

let schemaReady: Promise<void> | undefined;

/** Run the store's idempotent schema DDL once per process, so a fresh database
 * is set up automatically on the first request (no manual migration step). */
export function ensureSchema(store: PgVectorStore): Promise<void> {
  if (!schemaReady) {
    schemaReady = store.init().catch((err) => {
      schemaReady = undefined; // let a later request retry if this failed
      throw err;
    });
  }
  return schemaReady;
}
