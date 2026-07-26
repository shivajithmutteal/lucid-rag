/** An error carrying an HTTP status; route handlers map it to a response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, `"${field}" must be a non-empty string`);
  }
  return v;
}

export function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
