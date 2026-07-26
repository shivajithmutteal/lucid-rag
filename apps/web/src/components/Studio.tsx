'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { RetrievalMode } from '@lucid-rag/core';
import { ingestDocument, streamAsk, type AskDone } from '@/lib/client';
import { TraceView } from './TraceView';

export function Studio() {
  const [kbId, setKbId] = useState('kb1');
  const [kbName, setKbName] = useState('My Knowledge Base');

  // Upload
  const [docId, setDocId] = useState('doc1');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [contextualize, setContextualize] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  // Ask
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<RetrievalMode>('hybrid');
  const [checkFaithfulness, setCheckFaithfulness] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState('');
  const [done, setDone] = useState<AskDone | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploading(true);
    setUploadMsg(null);
    try {
      const res = await ingestDocument({
        knowledgeBase: { id: kbId, name: kbName },
        document: { id: docId, title: title || docId },
        text,
        contextualize,
      });
      setUploadMsg(`Indexed ${res.chunkCount} chunk(s)${res.contextualized ? ' (contextualized)' : ''}.`);
    } catch (err) {
      setUploadMsg(`Error: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  async function onAsk(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAsking(true);
    setAnswer('');
    setDone(null);
    setAskErr(null);
    await streamAsk(
      { knowledgeBaseId: kbId, query, params: { mode }, checkFaithfulness },
      {
        onToken: (d) => setAnswer((a) => a + d),
        onDone: (data) => {
          setDone(data);
          setAnswer(data.text);
        },
        onError: (data) => setAskErr(data.message),
      },
    );
    setAsking(false);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!title) setTitle(file.name);
    void file.text().then(setText);
  }

  return (
    <main className="app">
      <header>
        <h1>lucid-rag</h1>
        <p className="tag">
          A self-hostable, observable corporate RAG — see through every step of retrieval.
        </p>
      </header>

      <div className="kb">
        <label>
          Knowledge base id
          <input value={kbId} onChange={(e) => setKbId(e.target.value)} />
        </label>
        <label>
          name
          <input value={kbName} onChange={(e) => setKbName(e.target.value)} />
        </label>
      </div>

      <div className="cols">
        <form className="panel" onSubmit={onUpload}>
          <h2>Upload</h2>
          <label>
            Document id
            <input value={docId} onChange={(e) => setDocId(e.target.value)} required />
          </label>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="(optional)" />
          </label>
          <label>
            Text — paste, or load a .txt/.md file
            <input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={onFile} />
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="Paste document text (Markdown works well)…"
            required
          />
          <label className="check">
            <input type="checkbox" checked={contextualize} onChange={(e) => setContextualize(e.target.checked)} />
            contextualize each chunk (extra LLM calls)
          </label>
          <button disabled={uploading || !text}>{uploading ? 'Ingesting…' : 'Ingest'}</button>
          {uploadMsg && <p className="msg">{uploadMsg}</p>}
        </form>

        <form className="panel" onSubmit={onAsk}>
          <h2>Ask</h2>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="Ask a question about your documents…"
            required
          />
          <div className="row">
            <label>
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as RetrievalMode)}>
                <option value="hybrid">hybrid</option>
                <option value="semantic">semantic</option>
                <option value="keyword">keyword</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={checkFaithfulness}
                onChange={(e) => setCheckFaithfulness(e.target.checked)}
              />
              faithfulness check
            </label>
          </div>
          <button disabled={asking || !query}>{asking ? 'Thinking…' : 'Ask'}</button>
        </form>
      </div>

      {(answer || askErr) && (
        <section className="answer">
          <h2>Answer</h2>
          {askErr ? <p className="error">Error: {askErr}</p> : <p className="answer-text">{answer}</p>}

          {done && done.citations.length > 0 && (
            <ol className="citations">
              {done.citations.map((c) => {
                const src = done.trace.results.find((r) => r.chunk.id === c.chunkId);
                return (
                  <li key={c.n} value={c.n}>
                    <span className="cite-src">{c.section ?? src?.chunk.section ?? c.documentId}</span>
                    {src && <span className="cite-snip"> — {src.chunk.text.slice(0, 140)}…</span>}
                  </li>
                );
              })}
            </ol>
          )}

          {done?.faithfulness && (
            <p className={`faith ${done.faithfulness.supported ? 'ok' : 'warn'}`}>
              Faithfulness {Math.round(done.faithfulness.score * 100)}% —{' '}
              {done.faithfulness.supported ? 'supported' : 'unsupported'}
              {done.faithfulness.unsupportedClaims.length > 0 &&
                ` · unsupported: ${done.faithfulness.unsupportedClaims.join('; ')}`}
            </p>
          )}
        </section>
      )}

      {done && <TraceView trace={done.trace} />}
    </main>
  );
}
