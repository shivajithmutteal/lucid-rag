import type { RetrievalTrace, ScoredChunk } from '@lucid-rag/core';

const fmt = (n: number | undefined) => (typeof n === 'number' ? n.toFixed(3) : '—');
const snippet = (t: string, n = 200) => (t.length > n ? `${t.slice(0, n)}…` : t);

function ChunkRow({ c, badge }: { c: ScoredChunk; badge?: string }) {
  return (
    <li className="chunk">
      <div className="chunk-head">
        {badge && <span className="cite">{badge}</span>}
        <span className="rank">#{c.rank}</span>
        {c.chunk.section && <span className="section">{c.chunk.section}</span>}
        <span className="scores">
          {c.denseScore !== undefined && <span>dense {fmt(c.denseScore)}</span>}
          {c.sparseScore !== undefined && <span>sparse {fmt(c.sparseScore)}</span>}
          {c.fusedScore !== undefined && <span>fused {fmt(c.fusedScore)}</span>}
          {c.rerankScore !== undefined && <span>rerank {fmt(c.rerankScore)}</span>}
        </span>
      </div>
      <p className="chunk-text">{snippet(c.chunk.text)}</p>
    </li>
  );
}

function Stage({ title, chunks }: { title: string; chunks?: ScoredChunk[] }) {
  if (!chunks || chunks.length === 0) return null;
  return (
    <details className="stage">
      <summary>
        {title} <span className="count">({chunks.length})</span>
      </summary>
      <ul className="chunks">
        {chunks.map((c, i) => (
          <ChunkRow key={`${title}-${c.chunk.id}-${i}`} c={c} />
        ))}
      </ul>
    </details>
  );
}

export function TraceView({ trace }: { trace: RetrievalTrace }) {
  return (
    <section className="trace">
      <h2>Retrieval trace</h2>

      <div className="timings">
        <span className="mode">mode: {trace.params.mode}</span>
        {Object.entries(trace.timings).map(([k, v]) => (
          <span key={k} className="timing">
            {k} {Math.round(v)}ms
          </span>
        ))}
      </div>

      <h3>Results — top {trace.params.topK} (these feed the answer)</h3>
      <ul className="chunks">
        {trace.results.map((c, i) => (
          <ChunkRow key={c.chunk.id} c={c} badge={`[${i + 1}]`} />
        ))}
      </ul>

      {trace.nearMisses.length > 0 && (
        <>
          <h3 className="dim">Near-misses — just below the cutoff</h3>
          <ul className="chunks dim">
            {trace.nearMisses.map((c) => (
              <ChunkRow key={c.chunk.id} c={c} />
            ))}
          </ul>
        </>
      )}

      <h3>Stages</h3>
      <Stage title="Dense (semantic)" chunks={trace.stages.dense} />
      <Stage title="Sparse (keyword)" chunks={trace.stages.sparse} />
      <Stage title="Fused" chunks={trace.stages.fused} />
      <Stage title="Reranked" chunks={trace.stages.reranked} />
    </section>
  );
}
