import { describe, expect, it } from 'vitest';
import { buildMetadataFilter, toVectorLiteral } from '../src/sql';

describe('toVectorLiteral', () => {
  it('formats a vector as a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe('[0.1,0.2,-0.3]');
  });

  it('rejects an empty vector', () => {
    expect(() => toVectorLiteral([])).toThrow();
  });

  it('rejects non-finite values', () => {
    expect(() => toVectorLiteral([1, NaN, 3])).toThrow();
    expect(() => toVectorLiteral([1, Infinity])).toThrow();
  });
});

describe('buildMetadataFilter', () => {
  it('returns nothing for an empty or undefined filter', () => {
    expect(buildMetadataFilter(undefined, 3)).toEqual({ clauses: [], params: [], nextIndex: 3 });
    expect(buildMetadataFilter({}, 3)).toEqual({ clauses: [], params: [], nextIndex: 3 });
  });

  it('builds scalar equality via jsonb containment', () => {
    const f = buildMetadataFilter({ dept: 'legal' }, 3);
    expect(f.clauses).toEqual(['metadata @> $3::jsonb']);
    expect(f.params).toEqual(['{"dept":"legal"}']);
    expect(f.nextIndex).toBe(4);
  });

  it('handles null equality', () => {
    const f = buildMetadataFilter({ archived: null }, 1);
    expect(f.clauses).toEqual(['metadata @> $1::jsonb']);
    expect(f.params).toEqual(['{"archived":null}']);
    expect(f.nextIndex).toBe(2);
  });

  it('builds membership (in)', () => {
    const f = buildMetadataFilter({ region: { in: ['us', 'eu'] } }, 2);
    expect(f.clauses).toEqual(['metadata->($2::text) = ANY(ARRAY[$3::jsonb,$4::jsonb]::jsonb[])']);
    expect(f.params).toEqual(['region', '"us"', '"eu"']);
    expect(f.nextIndex).toBe(5);
  });

  it('treats an empty membership set as matching nothing', () => {
    const f = buildMetadataFilter({ region: { in: [] } }, 3);
    expect(f.clauses).toEqual(['false']);
    expect(f.params).toEqual([]);
    expect(f.nextIndex).toBe(3);
  });

  it('builds numeric ranges', () => {
    const f = buildMetadataFilter({ ts: { gte: 100, lte: 200 } }, 3);
    expect(f.clauses).toEqual([
      "CASE WHEN jsonb_typeof(metadata->($3::text)) = 'number' THEN (metadata->>($3::text))::numeric END >= $4",
      "CASE WHEN jsonb_typeof(metadata->($5::text)) = 'number' THEN (metadata->>($5::text))::numeric END <= $6",
    ]);
    expect(f.params).toEqual(['ts', 100, 'ts', 200]);
    expect(f.nextIndex).toBe(7);
  });

  it('chains multiple conditions with correct parameter indexing', () => {
    const f = buildMetadataFilter({ dept: 'legal', ts: { gte: 100 } }, 3);
    expect(f.clauses).toEqual([
      'metadata @> $3::jsonb',
      "CASE WHEN jsonb_typeof(metadata->($4::text)) = 'number' THEN (metadata->>($4::text))::numeric END >= $5",
    ]);
    expect(f.params).toEqual(['{"dept":"legal"}', 'ts', 100]);
    expect(f.nextIndex).toBe(6);
  });
});
