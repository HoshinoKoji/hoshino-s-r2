import { Hono } from 'hono';
import { authenticate, type Env } from './auth';
import { ApiError, bodyLength, ifRangeMatches, jsonBody, MiB, MAX_BODY, PART_SIZE, parseRange, requireValue } from './http';
import { openapi } from './openapi';
import { store } from './storage';

const app = new Hono<{ Bindings: Env; Variables: { identity: string; styleNonce: string } }>();

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store, no-transform');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  const styleNonce = crypto.randomUUID().replaceAll('-', '');
  c.set('styleNonce', styleNonce);
  c.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  c.set('identity', await authenticate(c.req.raw, c.env));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      throw new ApiError(403, 'cross_origin', 'Cross-origin mutations are not allowed');
    }
  }
  await next();
});

app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  console.error('API failure', error);
  return c.json({ error: { code: 'internal_error', message: 'Operation failed; retry or check Worker logs' } }, 500);
});

function keyOf(url: string): string {
  const key = new URL(url).searchParams.get('key');
  requireValue(key && !key.includes('\0') && new TextEncoder().encode(key).length <= 1024, 'key must contain 1–1024 UTF-8 bytes without NUL');
  return key;
}

app.get('/api/v1/buckets', c => c.json({ buckets: c.env.BUCKETS.map(({ id, label }) => ({ id, label })),
  identity: c.get('identity'), limits: { maxBody: MAX_BODY, partSize: PART_SIZE, maxParts: 10000 } }));
app.get('/api/v1/openapi.json', c => c.json(openapi));

app.get('/api/v1/buckets/:id/objects', async c => {
  const params = new URL(c.req.url).searchParams;
  const limit = Number(params.get('limit') ?? 100);
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'limit must be 1–1000');
  const delimiter = params.get('delimiter') ?? '/';
  requireValue(delimiter === '/' || delimiter === '', 'delimiter must be / or empty');
  return c.json(await store(c.env, c.req.param('id')).list({ limit, prefix: params.get('prefix') ?? '',
    cursor: params.get('cursor') || undefined, delimiter: delimiter || undefined }));
});

app.get('/api/v1/buckets/:id/metadata', async c => {
  const object = await store(c.env, c.req.param('id')).head(keyOf(c.req.url));
  if (!object) throw new ApiError(404, 'object_not_found', 'Object not found');
  return c.json(object);
});

app.on(['GET', 'HEAD'], '/api/v1/buckets/:id/object', async c => {
  const bucket = store(c.env, c.req.param('id'));
  const key = keyOf(c.req.url);
  const head = await bucket.head(key);
  if (!head) throw new ApiError(404, 'object_not_found', 'Object not found');
  const headers = new Headers({ 'Accept-Ranges': 'bytes', ETag: head.etag,
    'Last-Modified': new Date(head.uploaded).toUTCString(), 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(key.split('/').pop() || 'download').replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`,
    'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff' });
  const ifMatch = c.req.header('If-Match');
  if (ifMatch && ifMatch !== '*' && !ifMatch.split(',').map(s => s.trim()).includes(head.etag)) {
    return new Response(null, { status: 412, headers });
  }
  const ifNone = c.req.header('If-None-Match');
  if (ifNone && (ifNone === '*' || ifNone.split(',').map(s => s.trim().replace(/^W\//, '')).includes(head.etag))) {
    return new Response(null, { status: 304, headers });
  }
  let range: { offset: number; length: number } | undefined;
  const raw = c.req.header('Range');
  const ifRange = c.req.header('If-Range');
  // RFC: Range applies to GET only, not HEAD.
  if (c.req.method === 'GET' && raw && (!ifRange || ifRangeMatches(ifRange, head.etag, new Date(head.uploaded)))) {
    const parsed = parseRange(raw, head.size);
    if (!parsed) {
      headers.set('Content-Range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = parsed;
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  }
  headers.set('Content-Length', String(range?.length ?? head.size));
  if (c.req.method === 'HEAD') return new Response(null, { headers });
  // Pin get to the head ETag, including full responses: concurrent replacement cannot mix metadata/body.
  const response = await bucket.get(key, range, head.etag, head.size);
  if (response.status === 404) throw new ApiError(404, 'object_not_found', 'Object was deleted');
  if (response.status === 412) {
    headers.delete('Content-Length');
    headers.delete('Content-Range');
    return new Response(null, { status: 412, headers });
  }
  return new Response(response.body, { status: range ? 206 : 200, headers });
});

app.put('/api/v1/buckets/:id/object', async c => {
  const size = bodyLength(c.req.raw);
  const type = c.req.header('Content-Type') || 'application/octet-stream';
  const object = await store(c.env, c.req.param('id')).put(keyOf(c.req.url), size ? c.req.raw.body : null,
    size, type, c.req.raw.headers);
  if (!object) throw new ApiError(412, 'precondition_failed', 'Upload precondition failed');
  return c.json(object, 201);
});

app.delete('/api/v1/buckets/:id/object', async c => {
  await store(c.env, c.req.param('id')).delete(keyOf(c.req.url));
  return c.body(null, 204);
});

app.post('/api/v1/buckets/:id/uploads', async c => {
  const body = await jsonBody(c.req.raw);
  const key = body.key;
  requireValue(typeof key === 'string', 'key is required');
  keyOf(`https://local/?${new URLSearchParams({ key })}`);
  requireValue(Number.isSafeInteger(body.size) && (body.size as number) > 0, 'size must be a positive integer');
  const partSize = body.partSize ?? PART_SIZE;
  requireValue(Number.isSafeInteger(partSize) && (partSize as number) >= 5 * MiB && (partSize as number) <= MAX_BODY, 'partSize must be 5–64 MiB');
  requireValue(Math.ceil((body.size as number) / (partSize as number)) <= 10000, 'File requires more than 10,000 parts; increase partSize (maximum 64 MiB)');
  requireValue(body.contentType === undefined || (typeof body.contentType === 'string' && body.contentType.length <= 256), 'Invalid contentType');
  const uploadId = await store(c.env, c.req.param('id')).create(key, body.contentType as string || 'application/octet-stream');
  return c.json({ key, uploadId, partSize }, 201);
});

app.put('/api/v1/buckets/:id/uploads/:uploadId/parts/:number', async c => {
  const number = Number(c.req.param('number'));
  requireValue(Number.isInteger(number) && number >= 1 && number <= 10000, 'part number must be 1–10000');
  const size = bodyLength(c.req.raw);
  requireValue(size > 0 && c.req.raw.body, 'Part must not be empty');
  try { return c.json(await store(c.env, c.req.param('id')).uploadPart(keyOf(c.req.url), c.req.param('uploadId'), number, c.req.raw.body, size)); }
  catch (error) {
    if (error instanceof ApiError && error.code !== 'upload_unavailable') throw error;
    throw new ApiError(409, 'upload_unavailable', 'Upload part failed; session may have expired or been completed/aborted');
  }
});

app.post('/api/v1/buckets/:id/uploads/:uploadId/complete', async c => {
  const { parts } = await jsonBody(c.req.raw);
  requireValue(Array.isArray(parts) && parts.length > 0 && parts.length <= 10000, 'parts must contain 1–10000 entries');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Workers/local R2 can return opaque part ETags; do not assume they are MD5 hex strings.
    requireValue(part && part.partNumber === i + 1 && typeof part.etag === 'string' && part.etag.length > 0 && part.etag.length <= 512,
      'parts must be contiguous, sorted and contain valid ETags');
  }
  try { return c.json(await store(c.env, c.req.param('id')).complete(keyOf(c.req.url), c.req.param('uploadId'), parts)); }
  catch (error) {
    if (error instanceof ApiError && error.code !== 'upload_unavailable') throw error;
    throw new ApiError(409, 'upload_unavailable', 'Cannot complete upload; check session and part list');
  }
});

app.delete('/api/v1/buckets/:id/uploads/:uploadId', async c => {
  try { await store(c.env, c.req.param('id')).abort(keyOf(c.req.url), c.req.param('uploadId')); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, 'upload_unavailable', 'Upload is no longer available');
  }
  return c.body(null, 204);
});

app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Unknown API endpoint or method' } }, 404));
app.all('*', async c => {
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.body(null, 405);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  for (const name of ['Cache-Control', 'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy']) {
    const value = c.res.headers.get(name);
    if (value) headers.set(name, value);
  }
  const asset = new Response(response.body, { status: response.status, headers });
  if (c.req.method === 'GET' && headers.get('Content-Type')?.includes('text/html')) {
    // Allow only this response's Mantine style tags; scripts remain same-origin only.
    headers.delete('Content-Length');
    return new HTMLRewriter().on('head', {
      element(element) { element.append(`<meta name="style-nonce" content="${c.get('styleNonce')}">`, { html: true }); },
    }).transform(new Response(asset.body, { status: asset.status, headers }));
  }
  return asset;
});

export default app;
