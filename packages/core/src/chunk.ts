/**
 * Heading-aware Markdown chunker.
 *
 * Splits a document into retrieval-sized chunks that:
 *   - never cross a heading boundary (each chunk belongs to one heading span,
 *     even when two sibling sections share the same title),
 *   - carry the heading path as `section` (e.g. "Handbook > Leave"), supporting
 *     both ATX (`##`) and setext (underline) headings,
 *   - treat fenced code blocks (``` / ~~~) as opaque — `#` comment lines inside
 *     them are not headings, and interior blank lines don't split them,
 *   - pack whole paragraphs up to a token budget, splitting a single over-long
 *     paragraph by sentences without dropping any characters,
 *   - record exact `[charStart, charEnd)` offsets, so
 *     `originalText.slice(charStart, charEnd) === chunk.text`.
 *
 * Output is a {@link ChunkDraft}: the storage-agnostic shape the ingestion
 * pipeline turns into full `Chunk`s (adding ids, embedText, metadata).
 */
import { estimateTokens } from './tokenize';

export interface ChunkDraft {
  index: number;
  text: string;
  section?: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target maximum tokens per chunk (approximate). Default 180. */
  maxTokens?: number;
}

interface Segment {
  /** Trimmed paragraph text; equals `original.slice(start, end)`. */
  text: string;
  start: number;
  end: number;
  section?: string;
  /** Monotonic id bumped on every heading, so two same-titled sections differ. */
  sectionSeq: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const ATX_CLOSE = /\s+#+\s*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})/;
const SENTENCE = /[^.!?]+(?:[.!?]+|$)/g;

/** Break the document into paragraph segments, each tagged with its heading path. */
function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  const stack: { level: number; title: string }[] = [];
  let offset = 0;
  let sectionSeq = 0;
  let inCode = false;
  let fenceChar = '';
  let buf: { start: number; end: number } | null = null;

  // Empty-title headings drop out of the path; an all-empty path is `undefined`.
  const sectionPath = () => stack.map((h) => h.title).filter(Boolean).join(' > ') || undefined;

  const flush = () => {
    if (!buf) return;
    const raw = text.slice(buf.start, buf.end);
    const leading = raw.length - raw.replace(/^\s+/, '').length;
    const content = raw.trim();
    if (content.length > 0) {
      const start = buf.start + leading;
      segments.push({ text: content, start, end: start + content.length, section: sectionPath(), sectionSeq });
    }
    buf = null;
  };

  const pushHeading = (level: number, title: string) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    sectionSeq++; // every heading starts a new section span
  };

  // NB: `buf` is updated inline (not via a closure) so TypeScript's control-flow
  // analysis keeps its type as `{…} | null` in this loop rather than pinning it
  // to the `null` initializer.
  for (const line of text.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // account for the '\n' that split() consumed
    const content = line.replace(/\r$/, '');
    const trimmed = content.trim();

    // Fenced code block: toggle state; the fence line and interior are content.
    const fence = FENCE.exec(trimmed);
    if (fence) {
      if (!inCode) {
        inCode = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inCode = false;
      }
      if (!buf) buf = { start: lineStart, end: lineEnd };
      else buf.end = lineEnd;
      continue;
    }
    if (inCode) {
      if (!buf) buf = { start: lineStart, end: lineEnd };
      else buf.end = lineEnd;
      continue;
    }

    // ATX heading (strip any CommonMark closing '#' sequence from the title).
    const heading = HEADING.exec(content);
    if (heading) {
      flush();
      pushHeading(heading[1].length, heading[2].replace(ATX_CLOSE, '').trim());
      continue;
    }

    // Setext heading: a single buffered paragraph line underlined by === / ---.
    const setext = SETEXT.exec(content);
    if (setext && buf && text.slice(buf.start, buf.end).indexOf('\n') === -1) {
      const title = text.slice(buf.start, buf.end).trim();
      if (title.length > 0) {
        buf = null; // consume the heading text; discard the underline
        pushHeading(setext[1][0] === '=' ? 1 : 2, title);
        continue;
      }
    }

    if (trimmed === '') {
      flush();
      continue;
    }
    if (!buf) buf = { start: lineStart, end: lineEnd };
    else buf.end = lineEnd;
  }
  flush();
  return segments;
}

/** Sentence-split a single over-long segment, covering all of [0, len) so no
 * character is dropped, and emitting the whole segment if it has no sentences. */
function splitLongSegment(
  seg: Segment,
  maxTokens: number,
  emit: (start: number, end: number, section: string | undefined) => void,
): void {
  let packStart: number | null = null;
  let packEnd = 0;
  let packTokens = 0;
  let emittedAny = false;
  const flush = () => {
    if (packStart === null) return;
    emit(seg.start + packStart, seg.start + packEnd, seg.section);
    emittedAny = true;
    packStart = null;
    packTokens = 0;
  };
  SENTENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = SENTENCE.exec(seg.text)) !== null) {
    const piece = m[0];
    if (piece.trim().length === 0) continue;
    // The first pack starts at 0 so a leading .!? run isn't dropped; later packs
    // begin exactly where the previous one ended (the regex tiles contiguously).
    const s = first ? 0 : m.index;
    const e = m.index + piece.length;
    first = false;
    const t = estimateTokens(piece);
    if (packStart !== null && packTokens + t > maxTokens) flush();
    if (packStart === null) packStart = s;
    packEnd = e;
    packTokens += t;
  }
  flush();
  if (!emittedAny) emit(seg.start, seg.end, seg.section); // e.g. an all-'.!?' segment
}

export function chunkDocument(text: string, options?: ChunkOptions): ChunkDraft[] {
  const maxTokens = options?.maxTokens ?? 180;
  const segments = segment(text);
  const drafts: ChunkDraft[] = [];
  let index = 0;

  const emit = (start: number, end: number, section: string | undefined) => {
    const content = text.slice(start, end);
    drafts.push({ index: index++, text: content, section, charStart: start, charEnd: end, tokenCount: estimateTokens(content) });
  };

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (estimateTokens(seg.text) > maxTokens) {
      splitLongSegment(seg, maxTokens, emit);
      i++;
      continue;
    }
    // Pack consecutive paragraphs from the SAME heading span (same sectionSeq)
    // up to the budget — never across a heading boundary.
    const seq = seg.sectionSeq;
    const packStart = seg.start;
    let packEnd = seg.end;
    let packTokens = estimateTokens(seg.text);
    let j = i + 1;
    while (j < segments.length && segments[j].sectionSeq === seq) {
      const t = estimateTokens(segments[j].text);
      if (t > maxTokens || packTokens + t > maxTokens) break;
      packEnd = segments[j].end;
      packTokens += t;
      j++;
    }
    emit(packStart, packEnd, seg.section);
    i = j;
  }
  return drafts;
}
