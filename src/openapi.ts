const parameter = (name: string, location: string, required = true, schema: object = { type: 'string' }) => ({ name, in: location, required, schema });
const bucket = parameter('id', 'path');
const key = parameter('key', 'query');
const upload = parameter('uploadId', 'path');
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const error = { description: 'API error', ...json({ $ref: '#/components/schemas/Error' }) };
const object = { $ref: '#/components/schemas/Object' };
const part = { type: 'object', required: ['partNumber', 'etag'], properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, etag: { type: 'string' } } };
const operation = (summary: string, parameters: object[], responses: object, requestBody?: object) => ({ summary, parameters,
  ...(requestBody ? { requestBody } : {}), responses: { ...responses, '400': error, '401': error, '403': error, '404': error, '409': error, '413': error, '500': error } });

export const openapi = {
  openapi: '3.0.3', info: { title: 'CDLab R2 API', version: '0.1.0', description: 'Same-origin API behind Cloudflare Access. Service clients send both service token headers on every request. All authorized identities have full access to all configured buckets.' },
  servers: [{ url: '/api/v1' }], security: [{ AccessClientId: [], AccessClientSecret: [] }],
  paths: {
    '/buckets': { get: operation('List mounted buckets, identity and transfer limits', [], { '200': { description: 'Bucket list', ...json({ type: 'object', properties: { buckets: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } }, identity: { type: 'string' }, limits: { type: 'object' } } }) } }) },
    '/buckets/{id}/objects': { get: operation('List objects and directory prefixes', [bucket, parameter('prefix', 'query', false), parameter('cursor', 'query', false), parameter('delimiter', 'query', false, { type: 'string', enum: ['/', ''] }), parameter('limit', 'query', false, { type: 'integer', minimum: 1, maximum: 1000, default: 100 })], { '200': { description: 'Page; use truncated/cursor rather than object count', ...json({ type: 'object', properties: { objects: { type: 'array', items: object }, prefixes: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' }, cursor: { type: 'string', nullable: true } } }) } }) },
    '/buckets/{id}/metadata': { get: operation('Get metadata', [bucket, key], { '200': { description: 'Object metadata', ...json(object) } }) },
    '/buckets/{id}/object': {
      get: operation('Stream object or one byte range', [bucket, key, parameter('Range', 'header', false), parameter('If-Match', 'header', false), parameter('If-Range', 'header', false), parameter('If-None-Match', 'header', false)], {
        '200': { description: 'Full object', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        '206': { description: 'Single byte range; Content-Range describes returned bytes', headers: { 'Content-Range': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } }, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        '304': { description: 'Not modified' }, '412': { description: 'ETag precondition failed; restart download' }, '416': { description: 'Invalid/unsatisfiable range (multiple ranges unsupported)', headers: { 'Content-Range': { schema: { type: 'string' } } } },
      }),
      head: operation('Get download headers (Range ignored)', [bucket, key], { '200': { description: 'Content-Length, Accept-Ranges, ETag, Last-Modified' } }),
      put: operation('Upload an object up to 64 MiB; overwrite unless conditional header set', [bucket, key, parameter('Content-Length', 'header'), parameter('If-Match', 'header', false), parameter('If-None-Match', 'header', false)], { '201': { description: 'Uploaded', ...json(object) }, '412': { description: 'Precondition failed' } }, { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }),
      delete: operation('Delete object (idempotent)', [bucket, key], { '204': { description: 'Deleted' } }),
    },
    '/buckets/{id}/uploads': { post: operation('Create multipart upload; client persists uploadId and part ETags', [bucket], { '201': { description: 'Created', ...json({ type: 'object', properties: { key: { type: 'string' }, uploadId: { type: 'string' }, partSize: { type: 'integer' } } }) } }, { required: true, ...json({ type: 'object', required: ['key', 'size'], properties: { key: { type: 'string' }, size: { type: 'integer', minimum: 1 }, contentType: { type: 'string' }, partSize: { type: 'integer', minimum: 5242880, maximum: 67108864, default: 16777216 } } }) }) },
    '/buckets/{id}/uploads/{uploadId}/parts/{number}': { put: operation('Upload/retry part; non-final parts must be equal-sized and at least 5 MiB', [bucket, upload, key, parameter('number', 'path', true, { type: 'integer', minimum: 1, maximum: 10000 }), parameter('Content-Length', 'header')], { '200': { description: 'Uploaded part', ...json(part) } }, { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }) },
    '/buckets/{id}/uploads/{uploadId}/complete': { post: operation('Complete with contiguous sorted parts; atomically publishes/overwrites object', [bucket, upload, key], { '200': { description: 'Completed', ...json(object) } }, { required: true, ...json({ type: 'object', required: ['parts'], properties: { parts: { type: 'array', minItems: 1, maxItems: 10000, items: part } } }) }) },
    '/buckets/{id}/uploads/{uploadId}': { delete: operation('Abort upload', [bucket, upload, key], { '204': { description: 'Aborted' } }) },
  },
  components: {
    securitySchemes: { AccessClientId: { type: 'apiKey', in: 'header', name: 'CF-Access-Client-Id' }, AccessClientSecret: { type: 'apiKey', in: 'header', name: 'CF-Access-Client-Secret' } },
    schemas: {
      Object: { type: 'object', required: ['key', 'size', 'etag', 'uploaded', 'contentType'], properties: { key: { type: 'string' }, size: { type: 'integer' }, etag: { type: 'string', description: 'Quoted HTTP ETag, not necessarily a full-file MD5' }, uploaded: { type: 'string', format: 'date-time' }, contentType: { type: 'string' } } },
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
    },
  },
};
