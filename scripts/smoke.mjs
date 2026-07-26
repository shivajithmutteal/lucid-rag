#!/usr/bin/env node
// End-to-end smoke test against a RUNNING lucid-rag instance.
// Verifies health → ingest → ask (SSE) actually work together.
//
//   docker compose up --build -d
//   node scripts/smoke.mjs              # defaults to http://localhost:3000
//   BASE_URL=http://<host>:3000 node scripts/smoke.mjs
//
// Requires a reachable generator/embedder (a provider key or a running Ollama).

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const KB = 'smoke-kb';
const DOC = 'smoke-doc';
const TEXT =
  '# Team\n\nA football team has eleven players on the pitch.\n\n' +
  '# Match\n\nA match lasts ninety minutes, split into two halves.';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // 1. health
  const health = await fetch(`${BASE}/api/health`)
    .then((r) => r.json())
    .catch(() => null);
  check('health', health?.ok === true, health ? `embedder=${health.embedder} generator=${health.generator}` : 'no response');

  // 2. ingest
  const ingest = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      knowledgeBase: { id: KB, name: 'Smoke' },
      document: { id: DOC, title: 'Smoke' },
      text: TEXT,
    }),
  })
    .then((r) => r.json())
    .catch(() => null);
  check('ingest', ingest?.chunkCount > 0, ingest ? `chunks=${ingest.chunkCount}` : ingest?.error ?? 'no response');

  // 3. ask — parse the SSE stream
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ knowledgeBaseId: KB, query: 'how many players?', params: { mode: 'hybrid' } }),
  });

  let done = null;
  let error = null;
  let tokens = 0;
  let event = 'message';
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          const data = JSON.parse(line.slice(5).trim());
          if (event === 'token') tokens++;
          else if (event === 'done') done = data;
          else if (event === 'error') error = data;
        }
      }
    }
  } else {
    error = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
  }

  check('ask streamed tokens', tokens > 0, error ? `error: ${error.message}` : `${tokens} token events`);
  check(
    'ask returned an answer + trace',
    !!done && Array.isArray(done.trace?.results),
    done ? `results=${done.trace.results.length}, citations=${done.citations.length}` : error?.message ?? 'no done event',
  );

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err.message);
  process.exit(1);
});
