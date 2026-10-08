export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApiError(400, 'invalid_request', message);
}

export function parseRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0 || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) {
    if (!last) return null;
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== undefined && last < first)) return null;
  return { offset: first, length: Math.min(last ?? size - 1, size - 1) - first + 1 };
}

export function ifRangeMatches(value: string, etag: string, uploaded: Date): boolean {
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag;
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.floor(uploaded.getTime() / 1000) <= Math.floor(date / 1000);
}

export function metadata(object: R2Object) {
  return { key: object.key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded.toISOString(),
    contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
}

export const MiB = 1024 * 1024;
export const MAX_BODY = 64 * MiB;
export const PART_SIZE = 16 * MiB;

export function bodyLength(request: Request): number {
  const raw = request.headers.get('content-length');
  requireValue(raw !== null && /^\d+$/.test(raw), 'Content-Length is required');
  const size = Number(raw);
  requireValue(Number.isSafeInteger(size) && size >= 0, 'Invalid Content-Length');
  if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', 'Maximum request body is 64 MiB; use multipart upload');
  return size;
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  // Bound control-plane JSON, including streamed/chunked requests.
  const reader = request.body?.getReader();
  requireValue(reader, 'JSON body is required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 2 * MiB) {
      await reader.cancel();
      throw new ApiError(413, 'body_too_large', 'JSON body exceeds 2 MiB');
    }
    chunks.push(next.value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(all));
    requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'Malformed JSON');
  }
}
