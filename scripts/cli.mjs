#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const help = `R2 CLI (Node >=22)
Environment: R2_APP_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
  buckets
  ls BUCKET [PREFIX] [--flat] [--all]
  stat BUCKET KEY
  download BUCKET KEY FILE [--part-size MiB] [--concurrency 1..6] [--overwrite]
  upload BUCKET KEY FILE [--part-size MiB] [--concurrency 1..6] [--overwrite]
  abort BUCKET KEY FILE       Abort the saved multipart upload for FILE
  rm BUCKET KEY
Downloads and multipart uploads automatically resume using local sidecar files.
Downloads use FILE.part + FILE.download.json until complete.
Uploads use FILE.upload.json (full source SHA-256 checked on resume).
--overwrite explicitly allows replacing the destination object/file.
R2_APP_URL=http://localhost:8787 supports local development without credentials.`;

async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readState(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function saveState(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
async function pool(indices, count, work) {
  let cursor = 0;
  let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(indices.length, count) }, async () => {
    while (cursor < indices.length && !failed) {
      const index = indices[cursor++];
      try { await work(index); } catch (e) { failed = true; throw e; }
    }
  }));
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) { console.log(help); return; }
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--all', '--flat', '--overwrite'].includes(argv[i])) flags[argv[i].slice(2)] = true;
    else if (['--part-size', '--concurrency'].includes(argv[i])) {
      const flag = argv[i].slice(2); flags[flag] = Number(argv[++i]);
    } else if (argv[i].startsWith('--')) throw new Error(`Unknown flag ${argv[i]}`);
    else args.push(argv[i]);
  }
  const [command, bucket, key, input] = args;
  const count = { buckets: 1, ls: 2, stat: 3, download: 4, upload: 4, abort: 4, rm: 3 }[command];
  if (!count || args.length < count || args.length > count + (command === 'ls' ? 1 : 0)) throw new Error(help);
  if (!process.env.R2_APP_URL) throw new Error('Set R2_APP_URL, e.g. https://files.example.com or http://localhost:8787');
  const base = new URL(process.env.R2_APP_URL);
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('R2_APP_URL must be an origin, e.g. https://files.example.com');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (!local && base.protocol !== 'https:') throw new Error('Use HTTPS for remote connections');
  const headers = {};
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  } else if (!local) throw new Error('Set both Access service token environment variables');
  const partSize = (flags['part-size'] ?? 16) * MiB;
  const concurrency = flags.concurrency ?? 4;
  if (!Number.isSafeInteger(partSize) || partSize < 5 * MiB || partSize > 64 * MiB) throw new Error('Part size must be 5–64 MiB');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('Concurrency must be 1–6');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Interrupted; rerun the same command to resume'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const path = (route, params = {}) => new URL(`/api/v1/buckets/${encodeURIComponent(bucket)}/${route}?${new URLSearchParams(params)}`, base).href;
  async function req(url, init = {}, retries = 0) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          let message = `HTTP ${response.status}`;
          try { message = (await response.json()).error?.message ?? message; } catch {}
          const error = new Error(message); error.status = response.status; throw error;
        }
        return response;
      } catch (error) {
        if (controller.signal.aborted || attempt >= retries || (error.status && error.status < 500 && ![408, 429].includes(error.status))) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  async function api(url, init, retries) {
    const response = await req(url, init, retries);
    if (response.status === 204) return;
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Expected JSON; check Access authentication');
    return response.json();
  }
  const json = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    if (command === 'buckets') { console.log(JSON.stringify(await api(new URL('/api/v1/buckets', base)), null, 2)); return; }
    if (command === 'ls') {
      let cursor;
      do {
        const result = await api(path('objects', { prefix: key ?? '', delimiter: flags.flat ? '' : '/', ...(cursor ? { cursor } : {}) }));
        for (const prefix of result.prefixes) console.log(JSON.stringify({ prefix }));
        for (const object of result.objects) console.log(JSON.stringify(object));
        cursor = result.truncated ? result.cursor : null;
        if (cursor && !flags.all) console.error('More results available; use --all');
      } while (cursor && flags.all);
      return;
    }
    if (command === 'stat') { console.log(JSON.stringify(await api(path('metadata', { key })), null, 2)); return; }
    if (command === 'rm') { await api(path('object', { key }), { method: 'DELETE' }); console.log('Deleted'); return; }
    const file = resolve(input);
    const statePath = `${file}.${command === 'download' ? 'download' : 'upload'}.json`;
    const binding = { origin: base.origin, bucket, key, file };
    let state = await readState(statePath);
    if (state && Object.entries(binding).some(([k, v]) => state[k] !== v)) throw new Error('Sidecar belongs to a different file/object/server');
    if (state) {
      if (!Number.isSafeInteger(state.size) || state.size < 0 || !Number.isSafeInteger(state.partSize) || state.partSize < 5 * MiB || state.partSize > 64 * MiB || (command !== 'download' && Math.ceil(state.size / state.partSize) > 10000)) {
        throw new Error('Invalid sidecar transfer limits');
      }
      const total = Math.ceil(state.size / state.partSize);
      const entries = command === 'download' ? state.completed : state.parts;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid sidecar part list');
      for (const [index, value] of Object.entries(entries)) {
        const number = Number(index);
        if (!Number.isInteger(number) || (command === 'download' ? number < 0 || number >= total || !/^[a-f0-9]{64}$/.test(value) :
          number < 1 || number > total || value?.partNumber !== number || typeof value.etag !== 'string' || !/^[a-f0-9]{32}$/.test(value.md5))) {
          throw new Error('Invalid sidecar part record');
        }
      }
    }
    if (command === 'abort') {
      if (!state?.uploadId) throw new Error('No saved multipart upload');
      await api(path(`uploads/${encodeURIComponent(state.uploadId)}`, { key }), { method: 'DELETE' });
      await unlink(statePath);
      console.log('Aborted'); return;
    }
    if (command === 'download') {
      if (await exists(file) && !flags.overwrite) throw new Error('Destination exists; use --overwrite');
      const info = await api(path('metadata', { key }));
      const partial = `${file}.part`;
      if (state && (state.etag !== info.etag || state.size !== info.size)) throw new Error('Remote object changed; remove the sidecar and .part file before restarting');
      if (!state) {
        if (await exists(partial)) throw new Error('Untracked .part file exists; move/remove it before downloading');
        state = { ...binding, etag: info.etag, size: info.size, partSize, completed: {} };
        const handle = await open(partial, 'wx', 0o600); await handle.close();
        await saveState(statePath, state);
      }
      const handle = await open(partial, 'r+');
      let saves = Promise.resolve();
      try {
        const chunkSize = state.partSize;
        const chunks = Math.ceil(info.size / chunkSize);
        // Do not trust offsets alone: verify persisted chunks before resuming.
        for (const [raw, digest] of Object.entries(state.completed)) {
          const index = Number(raw); const length = Math.min(chunkSize, info.size - index * chunkSize);
          const bytes = Buffer.alloc(length);
          const result = await handle.read(bytes, 0, length, index * chunkSize);
          if (result.bytesRead !== length || hash(bytes) !== digest) delete state.completed[raw];
        }
        await pool(Array.from({ length: chunks }, (_, i) => i).filter(i => !state.completed[i]), concurrency, async index => {
          const start = index * chunkSize; const end = Math.min(info.size, start + chunkSize) - 1;
          const response = await req(path('object', { key }), { headers: { Range: `bytes=${start}-${end}`, 'If-Match': info.etag } }, 3);
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${info.size}` || response.headers.get('etag') !== info.etag) {
            await response.body?.cancel(); throw new Error('Invalid range response or changed ETag');
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length !== end - start + 1) throw new Error('Truncated download chunk; rerun to retry');
          let written = 0;
          while (written < bytes.length) { const result = await handle.write(bytes, written, bytes.length - written, start + written); if (!result.bytesWritten) throw new Error('Disk write made no progress'); written += result.bytesWritten; }
          const digest = hash(bytes);
          const save = saves.then(async () => {
            await handle.sync(); state.completed[index] = digest; await saveState(statePath, state);
            console.error(`Downloaded ${Object.keys(state.completed).length}/${chunks} parts`);
          });
          saves = save.catch(() => {}); await save;
        });
        await handle.truncate(info.size); await handle.sync();
      } finally { await saves; await handle.close(); }
      if (controller.signal.aborted) throw controller.signal.reason;
      await rename(partial, file); await unlink(statePath);
      console.log(`Downloaded ${file}`); return;
    }
    // Multipart source identity is checked with a full SHA-256; only one chunk is hashed at a time.
    const source = await stat(file);
    if (!source.isFile()) throw new Error('Upload source must be a regular file');
    const digest = await fileHash(file);
    if (state && (state.size !== source.size || state.sha256 !== digest)) throw new Error('Local source changed; abort the old upload before starting another');
    if (!state && !flags.overwrite) {
      try { await api(path('metadata', { key })); throw new Error('Remote object exists; use --overwrite'); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (source.size <= partSize && !state) {
      // Streaming request bodies need duplex in Node; no whole-file buffer for PUT.
      const object = await api(path('object', { key }), { method: 'PUT', body: createReadStream(file), duplex: 'half',
        headers: { 'Content-Length': String(source.size), 'Content-Type': 'application/octet-stream', ...(!flags.overwrite ? { 'If-None-Match': '*' } : {}) } });
      console.log(JSON.stringify(object, null, 2)); return;
    }
    if (!state) {
      if (Math.ceil(source.size / partSize) > 10000) throw new Error('Too many parts; increase --part-size (maximum 64 MiB)');
      const session = await api(path('uploads'), json({ key, size: source.size, partSize }));
      state = { ...binding, size: source.size, sha256: digest, partSize, uploadId: session.uploadId, parts: {} };
      await saveState(statePath, state);
    }
    const count = Math.ceil(state.size / state.partSize);
    const handle = await open(file, 'r');
    let saves = Promise.resolve();
    try {
      await pool(Array.from({ length: count }, (_, i) => i + 1).filter(n => !state.parts[n]), concurrency, async number => {
        const offset = (number - 1) * state.partSize; const length = Math.min(state.partSize, state.size - offset);
        const bytes = Buffer.alloc(length);
        let read = 0;
        while (read < length) { const result = await handle.read(bytes, read, length - read, offset + read); if (!result.bytesRead) throw new Error('Source file was truncated'); read += result.bytesRead; }
        const part = await api(path(`uploads/${encodeURIComponent(state.uploadId)}/parts/${number}`, { key }), {
          method: 'PUT', body: bytes, headers: { 'Content-Length': String(length) },
        }, 3);
        const save = saves.then(async () => { state.parts[number] = { ...part, md5: createHash('md5').update(bytes).digest('hex') }; await saveState(statePath, state); console.error(`Uploaded ${Object.keys(state.parts).length}/${count} parts`); });
        saves = save.catch(() => {}); await save;
      });
    } finally { await saves; await handle.close(); }
    const after = await stat(file);
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) throw new Error('Source changed during upload; abort and retry');
    const savedParts = Object.values(state.parts).sort((a, b) => a.partNumber - b.partNumber);
    const parts = savedParts.map(({ partNumber, etag }) => ({ partNumber, etag }));
    const expectedETag = '"' + createHash('md5').update(Buffer.concat(savedParts.map(part => Buffer.from(part.md5, 'hex')))).digest('hex') + `-${parts.length}"`;
    let object;
    try { object = await api(path(`uploads/${encodeURIComponent(state.uploadId)}/complete`, { key }), json({ parts })); }
    catch (error) {
      // Complete may have succeeded with a lost response. Confirm the resulting multipart ETag.
      const current = await api(path('metadata', { key })).catch(() => null);
      if (current?.etag !== expectedETag || current.size !== state.size) throw error;
      object = current;
    }
    await unlink(statePath);
    console.log(JSON.stringify(object, null, 2));
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
