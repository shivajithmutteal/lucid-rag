import { answerQuestion, retrieve } from '@lucid-rag/core';
import type { Answer, AnswerDeps, RetrievalMode, RetrievalParams, RetrieveDeps } from '@lucid-rag/core';
import { HttpError, requireString } from './http';

const MODES: RetrievalMode[] = ['keyword', 'semantic', 'hybrid'];

function posInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export interface AskRequest {
  knowledgeBaseId: string;
  query: string;
  params: RetrievalParams;
  checkFaithfulness: boolean;
}

export function parseAskRequest(body: unknown): AskRequest {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  const p = (b.params && typeof b.params === 'object' ? b.params : {}) as Record<string, unknown>;
  const mode = MODES.includes(p.mode as RetrievalMode) ? (p.mode as RetrievalMode) : 'hybrid';
  const params: RetrievalParams = {
    mode,
    candidateK: posInt(p.candidateK, 20),
    topK: posInt(p.topK, 5),
    semanticWeight:
      typeof p.semanticWeight === 'number' ? Math.min(1, Math.max(0, p.semanticWeight)) : undefined,
    rerank: p.rerank === true,
    nearMissCount: p.nearMissCount !== undefined ? posInt(p.nearMissCount, 3) : undefined,
  };
  return {
    knowledgeBaseId: requireString(b.knowledgeBaseId, 'knowledgeBaseId'),
    query: requireString(b.query, 'query'),
    params,
    checkFaithfulness: b.checkFaithfulness === true,
  };
}

export type AskDeps = RetrieveDeps & AnswerDeps;

export interface AskOptions {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Retrieve + answer for an already-validated request. `onToken` streams the answer. */
export async function runAsk(request: AskRequest, deps: AskDeps, opts?: AskOptions): Promise<Answer> {
  const trace = await retrieve(request.knowledgeBaseId, request.query, request.params, deps);
  return answerQuestion(trace, deps, {
    checkFaithfulness: request.checkFaithfulness,
    onToken: opts?.onToken,
    signal: opts?.signal,
  });
}

/** Validate a request body, then retrieve + answer. */
export async function handleAsk(body: unknown, deps: AskDeps, opts?: AskOptions): Promise<Answer> {
  return runAsk(parseAskRequest(body), deps, opts);
}
