import { api, endpoint, json, request, RequestError, type ObjectInfo } from './api';

export type State = 'running' | 'paused' | 'error' | 'complete' | 'cancelled';
interface DiskWriter { write(value: { type: 'write'; position: number; data: Uint8Array }): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface SaveHandle { createWritable(): Promise<DiskWriter> }
declare global { interface Window { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle> } }

export class Transfer {
  id = crypto.randomUUID();
  state: State = 'running';
  done = 0;
  error = '';
  started = Date.now();
  finishedAt: number | null = null;
  controller = new AbortController();
  private active = false;
  private waiters = new Set<() => void>();
  private runWork: () => Promise<void> = async () => {};
  private cleanup: () => Promise<void> = async () => {};

  constructor(public name: string, public total: number, public kind: 'upload' | 'download', public notify: () => void) {}

  setup(work: () => Promise<void>, cleanup: () => Promise<void>) {
    this.runWork = work;
    this.cleanup = cleanup;
  }
  async execute() {
    if (this.active || ['cancelled', 'complete'].includes(this.state)) return;
    this.active = true;
    this.state = 'running';
    this.finishedAt = null;
    this.error = '';
    this.notify();
    try {
      await this.runWork();
      if (!this.controller.signal.aborted) { this.state = 'complete'; this.done = this.total; }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.state = 'error';
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.active = false;
      if (this.state !== 'running') this.finishedAt ??= Date.now();
      if (this.controller.signal.aborted) await this.cleanup().catch(error => { this.error = `清理失败：${error.message}`; });
      this.notify();
    }
  }
  pause() { if (this.state === 'running') { this.state = 'paused'; this.notify(); } }
  resume() {
    if (this.state === 'paused') { this.state = 'running'; this.wakeAll(); this.notify(); }
    else if (this.state === 'error') void this.execute();
  }
  async cancel() {
    if (['cancelled', 'complete'].includes(this.state)) return;
    this.state = 'cancelled';
    this.finishedAt = Date.now();
    this.controller.abort();
    this.wakeAll();
    this.notify();
    if (!this.active) await this.cleanup().catch(error => { this.error = `清理失败：${error.message}`; this.notify(); });
  }
  async gate() {
    while (this.state === 'paused') await new Promise<void>(resolve => this.waiters.add(resolve));
    if (this.state === 'cancelled') throw new DOMException('已取消', 'AbortError');
  }
  private wakeAll() { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  progress(bytes: number) { this.done += bytes; this.notify(); }
}

async function retry<T>(task: Transfer, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await task.gate();
    try { return await operation(); } catch (error) {
      if (task.controller.signal.aborted || attempt >= 3 ||
        (error instanceof RequestError && error.status < 500 && ![408, 429].includes(error.status))) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function pool(indices: number[], count: number, task: Transfer, work: (index: number) => Promise<void>) {
  let cursor = 0;
  let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(indices.length, count) }, async () => {
    while (cursor < indices.length && !failed) {
      await task.gate();
      if (failed || cursor >= indices.length) break;
      const index = indices[cursor++];
      try { await work(index); } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export function download(bucket: string, info: ObjectInfo, handle: SaveHandle, partSize: number, concurrency: number, notify: () => void) {
  const task = new Transfer(info.key, info.size, 'download', notify);
  const completed = new Set<number>();
  let writer: DiskWriter | undefined;
  let writes: Promise<void> = Promise.resolve();
  task.setup(async () => {
    writer ??= await handle.createWritable();
    const indices = Array.from({ length: Math.ceil(info.size / partSize) }, (_, i) => i).filter(i => !completed.has(i));
    await pool(indices, concurrency, task, async index => {
      const start = index * partSize;
      const end = Math.min(info.size, start + partSize) - 1;
      const bytes = await retry(task, async () => {
        const response = await request(endpoint(bucket, 'object', { key: info.key }), {
          headers: { Range: `bytes=${start}-${end}`, 'If-Match': info.etag }, signal: task.controller.signal,
        });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${info.size}` ||
          response.headers.get('etag') !== info.etag || Number(response.headers.get('content-length')) !== end - start + 1) {
          await response.body?.cancel();
          throw new RequestError('分片响应不匹配，文件可能已变化；请取消并重新下载', 412);
        }
        // Only this chunk is buffered; at most concurrency chunks are resident.
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== end - start + 1) throw new Error('分片数据不完整');
        return bytes;
      });
      const write = writes.then(() => writer!.write({ type: 'write', position: start, data: bytes }));
      writes = write.catch(() => {});
      await write;
      completed.add(index);
      task.progress(bytes.byteLength);
    });
    await task.gate();
    await writer.close();
  }, async () => { await writes; await writer?.abort(); });
  return task;
}

export function upload(bucket: string, key: string, file: File, partSize: number, notify: () => void, onComplete: () => void) {
  const task = new Transfer(key, file.size, 'upload', notify);
  const parts = new Map<number, { partNumber: number; etag: string }>();
  let uploadId: string | undefined;
  task.setup(async () => {
    if (file.size <= partSize) {
      await retry(task, () => api(endpoint(bucket, 'object', { key }), { method: 'PUT', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' }, signal: task.controller.signal }));
      task.done = file.size;
    } else {
      if (!uploadId) {
        // Do not auto-retry session creation: a lost response could create orphan uploads.
        const session = await api<{ uploadId: string }>(endpoint(bucket, 'uploads'), {
          ...json({ key, size: file.size, partSize, contentType: file.type || 'application/octet-stream' }), signal: task.controller.signal,
        });
        uploadId = session.uploadId;
      }
      const indices = Array.from({ length: Math.ceil(file.size / partSize) }, (_, i) => i).filter(i => !parts.has(i + 1));
      await pool(indices, 3, task, async index => {
        const blob = file.slice(index * partSize, Math.min(file.size, (index + 1) * partSize));
        const part = await retry(task, () => api<{ partNumber: number; etag: string }>(endpoint(bucket,
          `uploads/${encodeURIComponent(uploadId!)}/parts/${index + 1}`, { key }), {
          method: 'PUT', body: blob, signal: task.controller.signal,
        }));
        parts.set(index + 1, part);
        task.progress(blob.size);
      });
      await task.gate();
      try {
        await api(endpoint(bucket, `uploads/${encodeURIComponent(uploadId)}/complete`, { key }),
          { ...json({ parts: [...parts.values()].sort((a, b) => a.partNumber - b.partNumber) }), signal: task.controller.signal });
      } catch (error) {
        throw new Error(`完成上传失败或响应丢失；请检查远端文件后决定重试。${error instanceof Error ? error.message : error}`);
      }
    }
    onComplete();
  }, async () => {
    if (uploadId) await api(endpoint(bucket, `uploads/${encodeURIComponent(uploadId)}`, { key }), { method: 'DELETE' });
  });
  return task;
}
