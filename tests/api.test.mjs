import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MiB = 1024 * 1024;
let mf, auth, root, privateKey;
const issuer = 'https://test.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const sha = data => createHash('sha256').update(data).digest('hex');

before(async () => {
  const result = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const options = {
    modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-03-01',
    r2Buckets: ['ONE', 'TWO'],
    bindings: { LOCAL_DEV: 'true', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience,
      BUCKETS: [{ id: 'one', label: '一', binding: 'ONE' }, { id: 'two', label: '二', binding: 'TWO' }] },
    serviceBindings: { ASSETS: () => new Response('<html>private assets</html>', { headers: { 'Content-Type': 'text/html' } }) },
  };
  mf = new Miniflare(options);
  await mf.ready;
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  auth = new Miniflare({ ...options, bindings: { ...options.bindings, LOCAL_DEV: 'false' },
    outboundService: request => {
      assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    } });
  await auth.ready;
  root = await mkdtemp(join(tmpdir(), 'cdlab-r2-test-'));
});
after(async () => { await mf?.dispose(); await auth?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });

const url = (bucket, route, params = {}) => `http://localhost/api/v1/buckets/${bucket}/${route}?${new URLSearchParams(params)}`;
const call = (bucket, route, params, init) => mf.dispatchFetch(url(bucket, route, params), init);
async function put(key, bytes, bucket = 'one') {
  const response = await call(bucket, 'object', { key }, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(Buffer.byteLength(bytes)) } });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('multi-bucket object isolation, special UTF-8 key and private download headers', async () => {
  const key = '目录/空 格+#%?../x.html';
  const meta = await put(key, '<script>alert(1)</script>');
  const response = await call('one', 'object', { key });
  assert.equal(await response.text(), '<script>alert(1)</script>');
  assert.equal(response.headers.get('etag'), meta.etag);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('cache-control'), /no-store.*no-transform/);
  assert.equal((await call('two', 'object', { key })).status, 404);
  assert.equal((await call('unknown', 'object', { key })).status, 404);
  assert.equal((await call('one', 'object', { key }, { method: 'DELETE' })).status, 204);
});

test('Range byte accuracy, suffix/open ranges, empty object and invalid ranges', async () => {
  const key = 'range.bin';
  await put(key, '0123456789');
  for (const [range, contentRange, expected] of [
    ['bytes=0-0', 'bytes 0-0/10', '0'], ['bytes=2-5', 'bytes 2-5/10', '2345'],
    ['bytes=7-', 'bytes 7-9/10', '789'], ['bytes=-3', 'bytes 7-9/10', '789'],
    ['bytes=8-99', 'bytes 8-9/10', '89'], ['bytes=-100', 'bytes 0-9/10', '0123456789'],
  ]) {
    const response = await call('one', 'object', { key }, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(await response.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=6-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'garbage', 'bytes=9007199254740993-']) {
    const response = await call('one', 'object', { key }, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  const head = await call('one', 'object', { key }, { method: 'HEAD', headers: { Range: 'bytes=0-0' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  await put('empty', '');
  assert.equal((await call('one', 'object', { key: 'empty' })).headers.get('content-length'), '0');
  assert.equal((await call('one', 'object', { key: 'empty' }, { headers: { Range: 'bytes=0-' } })).status, 416);
});

test('ETag conditionals and If-Range fall back to full response', async () => {
  const key = 'conditions'; const meta = await put(key, 'original');
  assert.equal((await call('one', 'object', { key }, { headers: { 'If-None-Match': meta.etag } })).status, 304);
  assert.equal((await call('one', 'object', { key }, { headers: { 'If-Match': '"wrong"' } })).status, 412);
  const ranged = await call('one', 'object', { key }, { headers: { Range: 'bytes=0-2', 'If-Range': meta.etag } });
  assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'ori');
  for (const condition of ['"wrong"', 'W/' + meta.etag, 'Thu, 01 Jan 1970 00:00:00 GMT']) {
    const full = await call('one', 'object', { key }, { headers: { Range: 'bytes=0-2', 'If-Range': condition } });
    assert.equal(full.status, 200); assert.equal(await full.text(), 'original');
  }
  const noOverwrite = await call('one', 'object', { key }, { method: 'PUT', body: 'new', headers: { 'If-None-Match': '*', 'Content-Length': '3' } });
  assert.equal(noOverwrite.status, 412);
  await put(key, 'replacement');
  assert.equal((await call('one', 'object', { key }, { headers: { Range: 'bytes=0-2', 'If-Match': meta.etag } })).status, 412);
});

test('directory listing paginates by cursor and supports flat prefix listing', async () => {
  for (const key of ['listing/a', 'listing/b', 'listing/c', 'listing/sub/d']) await put(key, key);
  let cursor, keys = [], prefixes = [];
  do {
    const response = await call('one', 'objects', { prefix: 'listing/', limit: '1', ...(cursor ? { cursor } : {}) });
    assert.equal(response.status, 200);
    const data = await response.json(); keys.push(...data.objects.map(o => o.key)); prefixes.push(...data.prefixes); cursor = data.truncated ? data.cursor : null;
  } while (cursor);
  assert.deepEqual(keys, ['listing/a', 'listing/b', 'listing/c']); assert.deepEqual(prefixes, ['listing/sub/']);
  const flat = await (await call('one', 'objects', { prefix: 'listing/', delimiter: '' })).json();
  assert.equal(flat.objects.length, 4);
  assert.equal((await call('one', 'objects', { limit: '0' })).status, 400);
});

test('multipart retry, completion, byte fidelity, malformed parts and abort', async () => {
  const key = 'multipart.bin';
  const data = Buffer.alloc(5 * MiB + 19, 37);
  const sessionResponse = await call('one', 'uploads', {}, post({ key, size: data.length, partSize: 5 * MiB }));
  assert.equal(sessionResponse.status, 201);
  const { uploadId } = await sessionResponse.json();
  const route = `uploads/${uploadId}`;
  const parts = [];
  for (const number of [1, 1, 2]) {
    const body = number === 1 ? data.subarray(0, 5 * MiB) : data.subarray(5 * MiB);
    const response = await call('one', `${route}/parts/${number}`, { key }, { method: 'PUT', body, headers: { 'Content-Length': String(body.length) } });
    assert.equal(response.status, 200);
    parts[number - 1] = await response.json();
  }
  assert.equal((await call('one', `${route}/complete`, { key }, post({ parts: [...parts].reverse() }))).status, 400);
  const complete = await call('one', `${route}/complete`, { key }, post({ parts }));
  assert.equal(complete.status, 200, JSON.stringify(parts) + ' ' + await complete.clone().text());
  const downloaded = Buffer.from(await (await call('one', 'object', { key })).arrayBuffer());
  assert.equal(sha(downloaded), sha(data));
  const second = await (await call('one', 'uploads', {}, post({ key: 'aborted', size: 10 }))).json();
  assert.equal((await call('one', `uploads/${second.uploadId}`, { key: 'aborted' }, { method: 'DELETE' })).status, 204);
  assert.equal((await call('one', 'metadata', { key: 'aborted' })).status, 404);
  assert.equal((await call('one', 'uploads', {}, post({ key: 'too-many', size: 64 * MiB * 10000 + 1, partSize: 64 * MiB }))).status, 400);
});

test('mutations reject cross-origin requests; OpenAPI is available', async () => {
  const response = await call('one', 'object', { key: 'forbidden' }, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
  const spec = await (await mf.dispatchFetch('http://localhost/api/v1/openapi.json')).json();
  assert.equal(spec.openapi, '3.0.3'); assert.ok(spec.paths['/buckets/{id}/uploads/{uploadId}/complete']);
  assert.match((await mf.dispatchFetch('http://localhost/')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

async function token({ aud = audience, iss = issuer, exp = Math.floor(Date.now() / 1000) + 600, email = 'test@example.com' } = {}) {
  return new SignJWT(email ? { email } : {}).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
}
test('Access protects API and assets and checks signature, issuer, audience, expiration', async () => {
  const target = 'https://files.example.com/api/v1/buckets';
  assert.equal((await auth.dispatchFetch(target)).status, 401);
  assert.equal((await auth.dispatchFetch('https://files.example.com/')).status, 401);
  for (const value of ['not-a-jwt', await token({ aud: 'wrong' }), await token({ iss: 'https://wrong.cloudflareaccess.com' }), await token({ exp: 1 })]) {
    assert.equal((await auth.dispatchFetch(target, { headers: { 'Cf-Access-Jwt-Assertion': value } })).status, 401);
  }
  const valid = await auth.dispatchFetch(target, { headers: { 'Cf-Access-Jwt-Assertion': await token() } });
  assert.equal(valid.status, 200); assert.equal((await valid.json()).identity, 'test@example.com');
  const service = await auth.dispatchFetch(target, { headers: { 'Cf-Access-Jwt-Assertion': await token({ email: null }) } });
  assert.equal(service.status, 200);
  const assets = await auth.dispatchFetch('https://files.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': await token() } });
  assert.equal(assets.status, 200); assert.match(assets.headers.get('cache-control'), /no-store/);
});

async function cli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['scripts/cli.mjs', ...args], { env: { ...process.env, R2_APP_URL: String(mfReady), CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => resolveResult({ code, stdout, stderr }));
  });
}
let mfReady;
test('CLI multipart upload/download, verified resume and changed-object refusal', async () => {
  mfReady = await mf.ready;
  const data = Buffer.alloc(11 * MiB + 53);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13 + (i >> 13)) & 255;
  const source = join(root, 'source.bin'); const output = join(root, 'output.bin');
  await writeFile(source, data);
  const uploaded = await cli(['upload', 'one', 'cli + #%.bin', source, '--part-size', '5']);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  const meta = JSON.parse(uploaded.stdout);
  // Seed a partially downloaded file and valid sidecar to exercise persistence across CLI invocations.
  const handle = await open(output + '.part', 'w');
  await handle.write(data.subarray(0, 5 * MiB), 0, 5 * MiB, 0); await handle.close();
  await writeFile(output + '.download.json', JSON.stringify({ origin: mfReady.origin, bucket: 'one', key: 'cli + #%.bin', file: output,
    etag: meta.etag, size: data.length, partSize: 5 * MiB, completed: { 0: sha(data.subarray(0, 5 * MiB)) } }));
  const downloaded = await cli(['download', 'one', 'cli + #%.bin', output]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.equal(sha(await readFile(output)), sha(data));
  assert.equal((await cli(['download', 'one', 'cli + #%.bin', output])).code, 1);
  await unlink(output);
  await writeFile(output + '.part', '');
  await writeFile(output + '.download.json', JSON.stringify({ origin: mfReady.origin, bucket: 'one', key: 'cli + #%.bin', file: output,
    etag: '"old"', size: data.length, partSize: 5 * MiB, completed: {} }));
  const refused = await cli(['download', 'one', 'cli + #%.bin', output]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /changed/);
});

test('CLI resumes saved upload parts and rejects modified source, then aborts', async () => {
  mfReady = await mf.ready;
  const data = Buffer.alloc(6 * MiB + 9, 87);
  const source = join(root, 'resume-source.bin');
  const key = 'cli-resume';
  await writeFile(source, data);
  const session = await (await call('one', 'uploads', {}, post({ key, size: data.length, partSize: 5 * MiB }))).json();
  const bytes = data.subarray(0, 5 * MiB);
  const part = await (await call('one', `uploads/${session.uploadId}/parts/1`, { key }, {
    method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.length) },
  })).json();
  const state = { origin: mfReady.origin, bucket: 'one', key, file: source, size: data.length, sha256: sha(data),
    partSize: 5 * MiB, uploadId: session.uploadId, parts: { 1: { ...part, md5: createHash('md5').update(bytes).digest('hex') } } };
  await writeFile(source + '.upload.json', JSON.stringify(state));
  const resumed = await cli(['upload', 'one', key, source]);
  assert.equal(resumed.code, 0, resumed.stderr); assert.match(resumed.stderr, /Uploaded 2\/2/); assert.doesNotMatch(resumed.stderr, /Uploaded 1\/2/);
  assert.equal(sha(Buffer.from(await (await call('one', 'object', { key })).arrayBuffer())), sha(data));
  const second = await (await call('one', 'uploads', {}, post({ key, size: data.length, partSize: 5 * MiB }))).json();
  await writeFile(source + '.upload.json', JSON.stringify({ ...state, uploadId: second.uploadId, parts: {} }));
  await writeFile(source, Buffer.alloc(data.length, 22));
  const refused = await cli(['upload', 'one', key, source]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /source changed/);
  const aborted = await cli(['abort', 'one', key, source]);
  assert.equal(aborted.code, 0, aborted.stderr);
});
