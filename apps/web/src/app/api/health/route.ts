import { NextResponse } from 'next/server';
import { getDeps } from '@/lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // reads env/DB at request time; never prerender

export function GET() {
  try {
    const deps = getDeps();
    return NextResponse.json({
      ok: true,
      embedder: deps.embedder.id,
      generator: deps.generator.id,
      readOnly: deps.readOnly,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
