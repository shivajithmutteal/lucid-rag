import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/chunk';

const DOC = `# Handbook

## Leave

Employees receive twenty days of annual leave. Requests go through the HR portal.

## Expenses

Expense reports must be filed within thirty days. Receipts are required over fifty dollars.
`;

describe('chunkDocument', () => {
  it('gives sequential indices and offsets that reconstruct the text exactly', () => {
    const chunks = chunkDocument(DOC, { maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(DOC.slice(c.charStart, c.charEnd)).toBe(c.text);
      expect(c.tokenCount).toBeGreaterThan(0);
    });
  });

  it('tags chunks with their heading path and never crosses sections', () => {
    const chunks = chunkDocument(DOC, { maxTokens: 200 });
    const sections = new Set(chunks.map((c) => c.section));
    expect(sections.has('Handbook > Leave')).toBe(true);
    expect(sections.has('Handbook > Expenses')).toBe(true);

    const leave = chunks.find((c) => c.section === 'Handbook > Leave');
    expect(leave?.text).toContain('annual leave');
    expect(leave?.text).not.toContain('Expense');
  });

  it('splits a single over-long paragraph into multiple offset-accurate chunks', () => {
    const long =
      '# T\n\n' +
      Array.from({ length: 20 }, (_, i) => `Sentence number ${i} covers a policy detail.`).join(' ');
    const chunks = chunkDocument(long, { maxTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(long.slice(c.charStart, c.charEnd)).toBe(c.text));
    expect(chunks.every((c) => c.section === 'T')).toBe(true);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkDocument('   \n\n  ')).toEqual([]);
    expect(chunkDocument('')).toEqual([]);
  });

  it('handles CRLF line endings without corrupting offsets', () => {
    const crlf = '# H\r\n\r\nFirst paragraph here.\r\n\r\nSecond paragraph here.\r\n';
    const chunks = chunkDocument(crlf, { maxTokens: 200 });
    chunks.forEach((c) => expect(crlf.slice(c.charStart, c.charEnd)).toBe(c.text));
  });

  it('treats fenced code blocks as opaque: # lines are not headings, blanks do not split', () => {
    const doc = '# Guide\n\nRun setup:\n\n```python\n# install deps first\nimport os\n\nx = 1\n```\n\nThen restart.';
    const chunks = chunkDocument(doc, { maxTokens: 500 });
    expect(chunks.every((c) => c.section === 'Guide')).toBe(true); // code comment is not a heading
    chunks.forEach((c) => expect(doc.slice(c.charStart, c.charEnd)).toBe(c.text));
    const withFence = chunks.find((c) => c.text.includes('```python'));
    expect(withFence?.text).toContain('x = 1'); // fence not split across a bogus heading
  });

  it('does not merge two sibling sections that share a heading title', () => {
    const doc = '# FAQ\n\n## Question\n\nWhat is the leave policy?\n\n## Question\n\nHow do I file expenses?';
    const chunks = chunkDocument(doc, { maxTokens: 500 });
    expect(chunks.filter((c) => c.section === 'FAQ > Question').length).toBe(2);
    chunks.forEach((c) => expect(c.text).not.toContain('## ')); // no heading markup leaks into a chunk
  });

  it('recognizes setext headings and drops the underline', () => {
    const chunks = chunkDocument('Overview\n========\n\nSome body under a setext heading.', { maxTokens: 200 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].section).toBe('Overview');
    expect(chunks[0].text).toBe('Some body under a setext heading.');
  });

  it('never drops content: an all-punctuation over-long segment still emits a chunk', () => {
    const doc = '# T\n\n' + '?'.repeat(400);
    const chunks = chunkDocument(doc, { maxTokens: 20 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join('')).toContain('?'.repeat(50));
  });

  it('strips the ATX closing-hash sequence from the section title', () => {
    expect(chunkDocument('## Leave ##\n\nBody.', { maxTokens: 200 })[0].section).toBe('Leave');
  });

  it('gives an empty-title heading a section of undefined, not an empty string', () => {
    expect(chunkDocument('# \n\nBody under empty heading.', { maxTokens: 200 })[0].section).toBeUndefined();
  });
});
