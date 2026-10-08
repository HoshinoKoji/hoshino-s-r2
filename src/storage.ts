import type { BucketConfig, Env } from './auth';
import { ApiError, metadata } from './http';
import { S3Store } from './s3';

export interface ObjectInfo { key: string; size: number; etag: string; uploaded: string; contentType: string }
export interface Page { objects: ObjectInfo[]; prefixes: string[]; truncated: boolean; cursor: string | null }
export interface Part { partNumber: number; etag: string }
export interface Store {
  list(options: { limit: number; prefix: string; cursor?: string; delimiter?: string }): Promise<Page>;
  head(key: string): Promise<ObjectInfo | null>;
  get(key: string, range: { offset: number; length: number } | undefined, etag: string, size: number): Promise<Response>;
  put(key: string, body: ReadableStream | null, size: number, type: string, headers: Headers): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  create(key: string, type: string): Promise<string>;
  uploadPart(key: string, uploadId: string, number: number, body: ReadableStream, size: number): Promise<Part>;
  complete(key: string, uploadId: string, parts: Part[]): Promise<ObjectInfo>;
  abort(key: string, uploadId: string): Promise<void>;
}

class R2Store implements Store {
  constructor(private binding: R2Bucket) {}
  async list({ limit, prefix, cursor, delimiter }: Parameters<Store['list']>[0]): Promise<Page> {
    const listed = await this.binding.list({ limit, prefix, cursor, delimiter, include: ['httpMetadata'] });
    return { objects: listed.objects.map(metadata), prefixes: listed.delimitedPrefixes,
      truncated: listed.truncated, cursor: listed.truncated ? listed.cursor : null };
  }
  async head(key: string) { const object = await this.binding.head(key); return object ? metadata(object) : null; }
  async get(key: string, range: { offset: number; length: number } | undefined, etag: string) {
    const object = await this.binding.get(key, { range, onlyIf: { etagMatches: etag.replace(/^"|"$/g, '') } });
    if (!object) return new Response(null, { status: 404 });
    if (!('body' in object)) return new Response(null, { status: 412 });
    return new Response(object.body, { status: range ? 206 : 200, headers: { ETag: object.httpEtag } });
  }
  async put(key: string, body: ReadableStream | null, _size: number, type: string, headers: Headers) {
    const object = await this.binding.put(key, body, { httpMetadata: { contentType: type }, onlyIf: headers });
    return object ? metadata(object) : null;
  }
  async delete(key: string) { await this.binding.delete(key); }
  async create(key: string, type: string) {
    return (await this.binding.createMultipartUpload(key, { httpMetadata: { contentType: type } })).uploadId;
  }
  async uploadPart(key: string, uploadId: string, number: number, body: ReadableStream) {
    return this.binding.resumeMultipartUpload(key, uploadId).uploadPart(number, body);
  }
  async complete(key: string, uploadId: string, parts: Part[]) {
    return metadata(await this.binding.resumeMultipartUpload(key, uploadId).complete(parts));
  }
  async abort(key: string, uploadId: string) { await this.binding.resumeMultipartUpload(key, uploadId).abort(); }
}

export function store(env: Env, id: string): Store {
  const config = env.BUCKETS.find((item: BucketConfig) => item.id === id);
  if (!config) throw new ApiError(404, 'bucket_not_found', 'Unknown bucket');
  if (config.type === 's3') return new S3Store(config, env);
  const binding = env[config.binding];
  if (!binding) throw new ApiError(503, 'binding_missing', 'Bucket binding is missing');
  return new R2Store(binding as R2Bucket);
}
