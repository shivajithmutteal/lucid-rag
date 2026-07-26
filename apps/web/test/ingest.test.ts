import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/http';
import { handleIngest } from '../src/lib/ingest';
import { FakeEmbedder, FakeStore } from './fakes';

const deps = () => ({ store: new FakeStore(), embedder: new FakeEmbedder() });

const validBody = {
  knowledgeBase: { id: 'kb1', name: 'HR' },
  document: { id: 'doc1', title: 'Handbook' },
  text: '# Leave\n\nEmployees get twenty days of leave.\n\n# Expenses\n\nFile within thirty days.',
};

describe('handleIngest', () => {
  it('ingests a document and reports the chunk count', async () => {
    const d = deps();
    const res = await handleIngest(validBody, d);
    expect(res.knowledgeBaseId).toBe('kb1');
    expect(res.documentId).toBe('doc1');
    expect(res.chunkCount).toBeGreaterThan(0);
    expect(d.store.chunks.size).toBe(res.chunkCount);
    expect(d.store.kbs.get('kb1')?.embeddingDims).toBe(3); // KB pinned to the embedder
  });

  it('rejects a body missing required fields with HttpError(400)', async () => {
    await expect(handleIngest({ knowledgeBase: { id: 'kb1' } }, deps())).rejects.toMatchObject({ status: 400 });
    await expect(handleIngest({ ...validBody, text: '' }, deps())).rejects.toBeInstanceOf(HttpError);
    await expect(handleIngest(null, deps())).rejects.toBeInstanceOf(HttpError);
  });
});
