import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let mf;
const objects = new Map();
const uploads = new Map();
const seen = [];
const keyName = '目录/空 格+#%.txt';
const uploaded = 'Wed, 01 Jan 2025 00:00:00 GMT';
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const etag = data => '"' + createHash('md5').update(data).digest('hex') + '"';
const meta = data => ({ ETag: etag(data), 'Last-Modified': uploaded, 'Content-Length': String(data.length), 'Content-Type': 'text/plain' });
const xml = (value, status = 200) => new Response(value, { status, headers: { 'Content-Type': 'application/xml' } });
const hmac = (key, data) => createHmac('sha1', key).update(data).digest('hex');
const sha = value => createHash('sha1').update(value).digest('hex');
const enc = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

function verifyCos(request) {
  const auth = request.headers.get('authorization');
  const params = new URLSearchParams(auth);
  assert.equal(params.get('q-sign-algorithm'), 'sha1');
  assert.equal(params.get('q-ak'), 'test-id');
  const time = params.get('q-key-time');
  const url = new URL(request.url);
  const query = [...url.searchParams].map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(params.get('q-url-param-list'), query.map(([name]) => enc(name)).join(';'));
  const string = `${request.method.toLowerCase()}\n${decodeURIComponent(url.pathname)}\n${query.map(([name, value]) => `${enc(name)}=${enc(value)}`).join('&')}\nhost=${enc(url.host)}\n`;
  assert.equal(params.get('q-signature'), hmac(hmac('test-key', time), `sha1\n${time}\n${sha(string)}\n`));
}

async function remote(request) {
  seen.push(request.url);
  const url = new URL(request.url);
  const isCos = url.hostname.endsWith('.myqcloud.com');
  if (isCos) {
    assert.equal(url.hostname, 'pictures-1250000000.cos.ap-guangzhou.myqcloud.com');
    verifyCos(request);
  } else {
    assert.equal(url.hostname, 's3.example.com');
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 Credential=test-id\//);
  }
  const bucket = isCos ? 'cos' : 's3';
  const path = isCos ? url.pathname.slice(1) : url.pathname.slice('/generic-bucket/'.length);
  const key = decodeURIComponent(path);
  if (key === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } });
  if (url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') || '';
    const delimiter = url.searchParams.get('delimiter');
    const members = [...objects].filter(([name]) => name.startsWith(`${bucket}:` + prefix));
    const items = [...new Map(members.map(([name, data]) => {
      const actual = name.slice(bucket.length + 1);
      const relative = actual.slice(prefix.length);
      const marker = delimiter && relative.includes(delimiter) ? prefix + relative.slice(0, relative.indexOf(delimiter) + 1) : actual;
      return [marker, marker === actual ? { actual, data } : { marker }];
    })).values()];
    const offset = Number(url.searchParams.get('continuation-token') || 0);
    const limit = Number(url.searchParams.get('max-keys') || 100);
    const entries = items.slice(offset, offset + limit).map(item => item.marker
      ? `<CommonPrefixes><Prefix>${escape(encodeURIComponent(item.marker))}</Prefix></CommonPrefixes>`
      : `<Contents><Key>${escape(encodeURIComponent(item.actual))}</Key><Size>${item.data.length}</Size><ETag>${escape(etag(item.data))}</ETag><LastModified>2025-01-01T00:00:00.000Z</LastModified></Contents>`).join('');
    const next = offset + limit < items.length;
    return xml(`<ListBucketResult><IsTruncated>${next}</IsTruncated>${next ? `<NextContinuationToken>${offset + limit}</NextContinuationToken>` : ''}${entries}</ListBucketResult>`);
  }
  const id = `${bucket}:${key}`;
  if (url.searchParams.has('uploads') && request.method === 'POST') {
    const uploadId = 'upload-' + (uploads.size + 1);
    uploads.set(uploadId, { id, parts: new Map(), type: request.headers.get('content-type') });
    return xml(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (url.searchParams.has('uploadId')) {
    const upload = uploads.get(url.searchParams.get('uploadId'));
    if (!upload || upload.id !== id) return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
    if (request.method === 'DELETE') { uploads.delete(url.searchParams.get('uploadId')); return new Response(null, { status: 204 }); }
    if (request.method === 'PUT') {
      const bytes = Buffer.from(await request.arrayBuffer());
      upload.parts.set(Number(url.searchParams.get('partNumber')), bytes);
      return new Response(null, { headers: { ETag: etag(bytes) } });
    }
    const body = await request.text();
    if (body.includes('force-error')) return xml('<Error><Code>InvalidPart</Code></Error>');
    assert.match(body, /<CompleteMultipartUpload>/);
    const bytes = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
    objects.set(id, bytes);
    uploads.delete(url.searchParams.get('uploadId'));
    return xml(`<CompleteMultipartUploadResult><ETag>${escape(etag(bytes))}</ETag></CompleteMultipartUploadResult>`);
  }
  if (request.method === 'DELETE') { objects.delete(id); return new Response(null, { status: 204 }); }
  if (request.method === 'PUT') {
    if (objects.has(id) && (request.headers.get('if-none-match') === '*' || request.headers.get('x-cos-forbid-overwrite') === 'true')) {
      return xml('<Error><Code>PreconditionFailed</Code></Error>', 412);
    }
    const bytes = Buffer.from(await request.arrayBuffer());
    objects.set(id, bytes);
    return new Response(null, { headers: { ETag: etag(bytes) } });
  }
  const bytes = objects.get(id);
  if (!bytes) return new Response(null, { status: 404 });
  if (request.method === 'HEAD') return new Response(null, { headers: meta(bytes) });
  if (request.headers.get('if-match') !== etag(bytes)) return new Response(null, { status: 412 });
  const range = /bytes=(\d+)-(\d+)/.exec(request.headers.get('range') || '');
  if (range) {
    const start = Number(range[1]), end = Number(range[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206,
      headers: { ...meta(bytes), 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  }
  return new Response(bytes, { headers: meta(bytes) });
}

before(async () => {
  const result = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-03-01',
    bindings: { LOCAL_DEV: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', TEST_ID: 'test-id', TEST_KEY: 'test-key',
      BUCKETS: [
        { id: 'cos', label: '腾讯 COS', type: 's3', provider: 'cos', bucketName: 'pictures-1250000000',
          endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', addressing: 'virtual',
          accessKeyIdSecret: 'TEST_ID', secretAccessKeySecret: 'TEST_KEY' },
        { id: 's3', label: '兼容 S3', type: 's3', provider: 's3', bucketName: 'generic-bucket',
          endpoint: 'https://s3.example.com', region: 'us-east-1', addressing: 'path',
          accessKeyIdSecret: 'TEST_ID', secretAccessKeySecret: 'TEST_KEY' },
        { id: 'missing', label: '缺少密钥', type: 's3', provider: 'cos', bucketName: 'missing-1250000000',
          endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', addressing: 'virtual',
          accessKeyIdSecret: 'NONE_ID', secretAccessKeySecret: 'NONE_KEY' },
      ] }, serviceBindings: { ASSETS: () => new Response('ok') }, outboundService: remote });
  await mf.ready;
});
after(async () => { await mf?.dispose(); });

const url = (bucket, route, key, extra = {}) => `http://localhost/api/v1/buckets/${bucket}/${route}?${new URLSearchParams(key === null ? extra : { key, ...extra })}`;
const call = (bucket, route, key, init, extra) => mf.dispatchFetch(url(bucket, route, key, extra), init);
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('COS mount provides private list/metadata/Range/conditional PUT and delete through shared API', async () => {
  const buckets = await (await mf.dispatchFetch('http://localhost/api/v1/buckets')).json();
  assert.deepEqual(buckets.buckets.map(item => item.id), ['cos', 's3', 'missing']);
  assert.ok(!JSON.stringify(buckets).includes('test-key'));
  assert.equal((await call('missing', 'objects', null)).status, 503);
  assert.equal((await call('cos', 'metadata', '../elsewhere')).status, 400);
  assert.equal((await call('s3', 'metadata', '../elsewhere')).status, 400);
  assert.equal((await call('cos', 'metadata', 'redirect')).status, 502);
  assert.ok(!seen.some(value => value.includes('attacker.example')));
  const bytes = Buffer.from('special 中文 + %');
  const put = await call('cos', 'object', keyName, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.length) } });
  assert.equal(put.status, 201, await put.clone().text());
  assert.equal((await put.json()).etag, etag(bytes));
  const refused = await call('cos', 'object', keyName, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.length), 'If-None-Match': '*' } });
  assert.equal(refused.status, 412);
  assert.equal((await call('cos', 'object', keyName, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.length), 'If-Match': etag(bytes) } })).status, 501);
  const info = await (await call('cos', 'metadata', keyName)).json();
  assert.equal(info.size, bytes.length);
  const page = await (await call('cos', 'objects', null, undefined, { prefix: '目录/', delimiter: '/' })).json();
  assert.deepEqual(page.objects.map(item => item.key), [keyName]);
  const ranged = await call('cos', 'object', keyName, { headers: { Range: 'bytes=2-5', 'If-Match': etag(bytes) } });
  assert.equal(ranged.status, 206, await ranged.clone().text());
  assert.equal(await ranged.text(), bytes.subarray(2, 6).toString());
  assert.equal((await call('cos', 'object', keyName, { headers: { 'If-Match': '"bad"' } })).status, 412);
  assert.equal((await call('cos', 'object', keyName, { method: 'DELETE' })).status, 204);
  assert.equal((await call('cos', 'metadata', keyName)).status, 404);
  assert.ok(seen.some(value => value.includes('pictures-1250000000.cos.ap-guangzhou.myqcloud.com')));
});

test('generic SigV4 S3 path mount paginates, uploads parts and aborts using same routes', async () => {
  for (const key of ['folder/a', 'folder/b', 'folder/sub/c']) {
    const res = await call('s3', 'object', key, { method: 'PUT', body: key, headers: { 'Content-Length': String(key.length) } });
    assert.equal(res.status, 201, await res.clone().text());
  }
  let cursor, keys = [], dirs = [];
  do {
    const page = await (await call('s3', 'objects', null, undefined, { prefix: 'folder/', limit: '1', ...(cursor ? { cursor } : {}) })).json();
    keys.push(...page.objects.map(item => item.key)); dirs.push(...page.prefixes);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(keys, ['folder/a', 'folder/b']); assert.deepEqual(dirs, ['folder/sub/']);
  const data = Buffer.alloc(5 * 1024 * 1024 + 13, 37);
  const created = await call('s3', 'uploads', null, post({ key: 'large', size: data.length, partSize: 5 * 1024 * 1024 }));
  assert.equal(created.status, 201, await created.clone().text());
  const { uploadId } = await created.json();
  const parts = [];
  for (let number = 1; number <= 2; number++) {
    const bytes = data.subarray((number - 1) * 5 * 1024 * 1024, number * 5 * 1024 * 1024);
    const res = await call('s3', `uploads/${uploadId}/parts/${number}`, 'large', { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.length) } });
    assert.equal(res.status, 200, await res.clone().text()); parts.push(await res.json());
  }
  const completed = await call('s3', `uploads/${uploadId}/complete`, 'large', post({ parts }));
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await completed.json()).size, data.length);
  assert.deepEqual(Buffer.from(await (await call('s3', 'object', 'large')).arrayBuffer()), data);
  const aborted = await (await call('s3', 'uploads', null, post({ key: 'aborted', size: 1 }))).json();
  assert.equal((await call('s3', `uploads/${aborted.uploadId}`, 'aborted', { method: 'DELETE' })).status, 204);
  const failing = await (await call('s3', 'uploads', null, post({ key: 'failure', size: 1 }))).json();
  assert.equal((await call('s3', `uploads/${failing.uploadId}/complete`, 'failure', post({ parts: [{ partNumber: 1, etag: '"force-error"' }] }))).status, 409);
});

test('COS multipart uploads return the completed object and reject embedded 200 XML errors', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 9, 41);
  const { uploadId } = await (await call('cos', 'uploads', null, post({ key: 'cos-large', size: bytes.length, partSize: 5 * 1024 * 1024 }))).json();
  const parts = [];
  for (let number = 1; number <= 2; number++) {
    const chunk = bytes.subarray((number - 1) * 5 * 1024 * 1024, number * 5 * 1024 * 1024);
    const response = await call('cos', `uploads/${uploadId}/parts/${number}`, 'cos-large', { method: 'PUT', body: chunk, headers: { 'Content-Length': String(chunk.length) } });
    assert.equal(response.status, 200); parts.push(await response.json());
  }
  assert.equal((await call('cos', `uploads/${uploadId}/complete`, 'cos-large', post({ parts: [{ partNumber: 1, etag: '"force-error"' }] }))).status, 409);
  const complete = await call('cos', `uploads/${uploadId}/complete`, 'cos-large', post({ parts }));
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.equal((await complete.json()).size, bytes.length);
  assert.deepEqual(Buffer.from(await (await call('cos', 'object', 'cos-large')).arrayBuffer()), bytes);
});

test('CLI can upload and download a mounted COS object without storage credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hoshino-cos-cli-'));
  const run = async (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cli.mjs', ...args], { env: {
      ...process.env, R2_APP_URL: (awaitReady).origin, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '',
    } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stderr }));
  });
  const awaitReady = await mf.ready;
  try {
    const source = join(dir, 'in.txt'), output = join(dir, 'out.txt');
    await writeFile(source, 'CLI → COS byte-exact data');
    const saved = await run('upload', 'cos', 'cli/中文.txt', source);
    assert.equal(saved.code, 0, saved.stderr);
    const result = await run('download', 'cos', 'cli/中文.txt', output);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(output), await readFile(source));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
