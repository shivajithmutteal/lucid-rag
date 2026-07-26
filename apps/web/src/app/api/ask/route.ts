import { getDeps } from '@/lib/deps';
import { parseAskRequest, runAsk } from '@/lib/ask';
import { HttpError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * POST /api/ask → Server-Sent Events:
 *   event: token  data: "<delta>"          (streamed answer text)
 *   event: done   data: { text, citations, trace, faithfulness }
 *   event: error  data: { status, message } (failures after the stream opens)
 *
 * Request validation happens up front, so a bad request gets a real HTTP 400.
 */
export async function POST(req: Request) {
  const deps = getDeps();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  let request;
  try {
    request = parseAskRequest(body);
  } catch (err) {
    return json({ error: (err as Error).message }, err instanceof HttpError ? err.status : 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const answer = await runAsk(request, deps, { onToken: (d) => send('token', d), signal: req.signal });
        send('done', {
          text: answer.text,
          citations: answer.citations,
          trace: answer.trace,
          faithfulness: answer.faithfulness,
        });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        send('error', { status, message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
