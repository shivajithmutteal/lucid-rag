export default function Home() {
  return (
    <main className="wrap">
      <h1>lucid-rag</h1>
      <p>
        A self-hostable, provider-agnostic, observable corporate RAG. The chat and
        glass-box trace-viewer UI lands in the next sub-phase.
      </p>
      <p>
        API: <code>GET /api/health</code> · <code>POST /api/ingest</code> ·{' '}
        <code>POST /api/ask</code> (Server-Sent Events).
      </p>
    </main>
  );
}
