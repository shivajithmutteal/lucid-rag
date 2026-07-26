import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  // Emit a self-contained server bundle for a small Docker image.
  output: 'standalone',
  // The monorepo root, so file tracing picks up the workspace packages.
  outputFileTracingRoot: path.resolve('..', '..'),
  // The @lucid-rag/* workspace packages ship raw TypeScript — Next compiles them.
  transpilePackages: ['@lucid-rag/core', '@lucid-rag/providers', '@lucid-rag/store-postgres'],
  // Keep the native-ish pg driver external (not bundled).
  serverExternalPackages: ['pg'],
};

export default config;
