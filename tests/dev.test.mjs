import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { generate } from '../scripts/config.mjs';

test('generated local TOML boots Wrangler with authenticated static assets and two buckets', { timeout: 45000 }, async () => {
  await generate('tests/fixtures/deploy.toml', true);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
  });
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.generated.toml', '--ip', '127.0.0.1', '--port', String(port)],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
  let logs = '', exited = false;
  const stopped = new Promise(resolve => child.on('exit', () => { exited = true; resolve(); }));
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      try {
        const response = await fetch(origin + '/api/v1/buckets', { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(ready, true, logs);
    const buckets = await (await fetch(origin + '/api/v1/buckets')).json();
    assert.equal(buckets.buckets.length, 2); assert.equal(buckets.identity, '本地开发');
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const html = await response.text();
    assert.match(html, /R2 文件管理器/);
    const nonce = /<meta name="style-nonce" content="([a-f0-9]{32})">/.exec(html)?.[1];
    assert.ok(nonce);
    assert.ok(response.headers.get('content-security-policy').includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
    const second = await fetch(origin);
    const secondHtml = await second.text();
    const secondNonce = /<meta name="style-nonce" content="([a-f0-9]{32})">/.exec(secondHtml)?.[1];
    assert.ok(secondNonce);
    assert.notEqual(secondNonce, nonce);
    assert.ok(second.headers.get('content-security-policy').includes(`'nonce-${secondNonce}'`));
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script);
    assert.equal((await fetch(origin + script)).status, 200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (!exited) { child.kill('SIGKILL'); await stopped; }
  }
});
