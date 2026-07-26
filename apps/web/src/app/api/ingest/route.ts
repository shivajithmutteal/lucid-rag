import { NextResponse } from 'next/server';
import { getDeps } from '@/lib/deps';
import { HttpError } from '@/lib/http';
import { handleIngest } from '@/lib/ingest';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const deps = getDeps();
  if (deps.readOnly) {
    return NextResponse.json({ error: 'ingestion is disabled on this instance (LUCID_READONLY)' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const contextualize =
      typeof body === 'object' && body !== null && (body as Record<string, unknown>).contextualize === true;
    const result = await handleIngest(body, deps, { contextualize });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
