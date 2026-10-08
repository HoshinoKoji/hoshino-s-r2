import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/transfers.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { download, upload, Transfer } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('browser download limits concurrency, pauses/resumes and writes exact offsets', async () => {
  const original = globalThis.fetch;
  const data = new TextEncoder().encode('0123456789abcdef');
  const output = new Uint8Array(data.length);
  let active = 0, maxActive = 0, calls = 0, closed = false, writing = false;
  let task;
  globalThis.fetch = async (_, init) => {
    active++; maxActive = Math.max(maxActive, active); calls++;
    assert.equal(init.headers['If-Match'], '"version"');
    const [start, end] = init.headers.Range.slice(6).split('-').map(Number);
    await tick(); active--;
    return new Response(data.slice(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1), ETag: '"version"',
    } });
  };
  try {
    const writer = {
      async write({ position, data }) { assert.equal(writing, false); writing = true; await tick(); output.set(data, position); writing = false; },
      async close() { closed = true; }, async abort() {},
    };
    task = download('one', { key: 'file', size: data.length, etag: '"version"' }, { async createWritable() { return writer; } }, 4, 3, () => {
      if (task?.done === 4) task.pause();
    });
    const running = task.execute();
    while (task.state !== 'paused') await tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false); const pausedCalls = calls;
    await tick(); assert.equal(calls, pausedCalls);
    task.resume(); await running;
    assert.equal(task.state, 'complete'); assert.equal(task.done, data.length); assert.equal(closed, true);
    assert.equal(calls, 4); assert.ok(maxActive <= 3); assert.deepEqual(output, data);
  } finally { globalThis.fetch = original; }
});

test('browser rejects changed ETag and cancellation aborts the writer', async () => {
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async () => new Response('oops', { status: 412 });
  try {
    const task = download('one', { key: 'file', size: 8, etag: '"version"' }, { async createWritable() {
      return { async write() { assert.fail('must not write changed data'); }, async close() {}, async abort() { aborted = true; } };
    } }, 4, 2, () => {});
    await task.execute(); assert.equal(task.state, 'error'); assert.equal(task.done, 0);
    await task.cancel(); assert.equal(aborted, true); assert.equal(task.state, 'cancelled');
  } finally { globalThis.fetch = original; }
});

test('browser multipart retries only failed parts and completes sorted parts', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let failed = false, completed;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/uploads')) return Response.json({ uploadId: 'session' });
    if (url.includes('/parts/')) {
      const number = Number(/\/parts\/(\d+)/.exec(url)[1]); calls.push(number);
      if (number === 2 && !failed) { failed = true; return Response.json({ error: { message: 'temporary' } }, { status: 503 }); }
      return Response.json({ partNumber: number, etag: String(number).repeat(32) });
    }
    if (url.includes('/complete')) { completed = JSON.parse(init.body).parts; return Response.json({}); }
    assert.fail(url);
  };
  try {
    const task = upload('one', 'file', new File(['0123456789'], 'file'), 4, () => {}, () => {});
    await task.execute(); assert.equal(task.state, 'complete'); assert.equal(task.done, 10);
    assert.equal(calls.filter(n => n === 1).length, 1); assert.equal(calls.filter(n => n === 2).length, 2);
    assert.deepEqual(completed.map(p => p.partNumber), [1, 2, 3]);
  } finally { globalThis.fetch = original; }
});

test('cancel wakes all paused work without starting another operation', async () => {
  const task = new Transfer('test', 10, 'download', () => {});
  let cleaned = false;
  task.setup(async () => { task.pause(); await Promise.all([task.gate(), task.gate(), task.gate()]); assert.fail('cancel should throw'); }, async () => { cleaned = true; });
  const running = task.execute(); await tick(); await task.cancel(); await running;
  assert.equal(task.state, 'cancelled'); assert.equal(cleaned, true);
});
