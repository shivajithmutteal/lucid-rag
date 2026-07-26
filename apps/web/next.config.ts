import type { NextConfig } from 'next';

const config: NextConfig = {
  // The @lucid-rag/* workspace packages ship raw TypeScript — Next compiles them.
  transpilePackages: ['@lucid-rag/core', '@lucid-rag/providers', '@lucid-rag/store-postgres'],
  // Keep the native-ish pg driver external (not bundled).
  serverExternalPackages: ['pg'],
};

export default config;
