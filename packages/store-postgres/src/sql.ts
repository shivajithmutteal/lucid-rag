import type { MetadataFilter, MetadataValue } from '@lucid-rag/core';

/**
 * Format a numeric embedding as a pgvector text literal: `[0.1,0.2,0.3]`.
 *
 * The result is always passed as a *bound parameter* (cast to `::vector` in the
 * SQL), never string-concatenated into a query, so there is no injection
 * surface. Rejects empty or non-finite input, which pgvector would reject anyway
 * — better to fail loudly at the call site.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('toVectorLiteral: embedding must be a non-empty number[]');
  }
  for (const v of embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('toVectorLiteral: embedding contains a non-finite value');
    }
  }
  return `[${embedding.join(',')}]`;
}

/** The SQL fragment produced for a metadata filter. */
export interface FilterSql {
  /** Boolean expressions to AND into a WHERE clause (empty when no filter). */
  clauses: string[];
  /** Bound parameters, in the order the clauses reference them. */
  params: unknown[];
  /** The next free positional-parameter index ($n) after this filter. */
  nextIndex: number;
}

/**
 * Translate a {@link MetadataFilter} into parameterized SQL over a jsonb column.
 *
 * Every key and value becomes a bound parameter ($n) — nothing is interpolated
 * into the SQL text — so arbitrary, user-supplied metadata keys are safe.
 *
 *   equality      → `metadata @> $n::jsonb`                        (containment; GIN-indexed)
 *   `{ in: [..] }`→ `metadata -> $k = ANY(ARRAY[$v..]::jsonb[])`
 *   `{ gte,lte }` → numeric compare guarded by `jsonb_typeof(metadata->$k)='number'`
 *                   so non-numeric/absent values are excluded, never cast-error
 *
 * @param startIndex the first positional-parameter number available to this filter.
 * @param column     the jsonb column to filter on (internal; never user input).
 */
export function buildMetadataFilter(
  filter: MetadataFilter | undefined,
  startIndex: number,
  column = 'metadata',
): FilterSql {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  if (!filter) return { clauses, params, nextIndex: i };

  for (const [key, cond] of Object.entries(filter)) {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('in' in cond) {
        const values = cond.in;
        if (values.length === 0) {
          // An empty membership set can never match.
          clauses.push('false');
          continue;
        }
        const keyIdx = i++;
        const valPlaceholders = values.map(() => `$${i++}::jsonb`);
        clauses.push(
          `${column}->($${keyIdx}::text) = ANY(ARRAY[${valPlaceholders.join(',')}]::jsonb[])`,
        );
        params.push(key, ...values.map((v) => JSON.stringify(v)));
      } else {
        // Numeric range. jsonb_typeof guards the cast: strings, booleans, an
        // absent key, and JSON null are not 'number', so the CASE yields NULL and
        // the row is excluded — rather than `::numeric` raising a cast error that
        // would abort the entire search query.
        if (cond.gte !== undefined) {
          const keyIdx = i++;
          const valIdx = i++;
          clauses.push(
            `CASE WHEN jsonb_typeof(${column}->($${keyIdx}::text)) = 'number' ` +
              `THEN (${column}->>($${keyIdx}::text))::numeric END >= $${valIdx}`,
          );
          params.push(key, cond.gte);
        }
        if (cond.lte !== undefined) {
          const keyIdx = i++;
          const valIdx = i++;
          clauses.push(
            `CASE WHEN jsonb_typeof(${column}->($${keyIdx}::text)) = 'number' ` +
              `THEN (${column}->>($${keyIdx}::text))::numeric END <= $${valIdx}`,
          );
          params.push(key, cond.lte);
        }
      }
    } else {
      // Scalar equality (including null): jsonb containment.
      const idx = i++;
      clauses.push(`${column} @> $${idx}::jsonb`);
      params.push(JSON.stringify({ [key]: cond as MetadataValue }));
    }
  }
  return { clauses, params, nextIndex: i };
}
