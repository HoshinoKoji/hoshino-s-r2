import { AwsClient } from 'aws4fetch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { BucketConfig, Env } from './auth';
import { ApiError } from './http';
import type { ObjectInfo, Page, Part, Store } from './storage';

type S3Config = Extract<BucketConfig, { type: 's3' }>;
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const xmlEscape = (value: string) => value.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);
const values = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

async function sha1(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-1', encoder.encode(value))); }
async function hmac(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)));
}

// Tencent COS XML API's documented q-sign-algorithm=sha1 signature, using only Host as a signed header.
export async function cosAuthorization(url: URL, method: string, secretId: string, secretKey: string, now = Date.now()): Promise<string> {
  const keyTime = `${Math.floor(now / 1000)};${Math.floor(now / 1000) + 600}`;
  const query = [...url.searchParams].map(([key, value]) => [key.toLowerCase(), value] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const parameters = query.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const path = decodeURIComponent(url.pathname);
  const httpString = `${method.toLowerCase()}\n${path}\n${parameters}\nhost=${encode(url.host)}\n`;
  const signKey = await hmac(secretKey, keyTime);
  const signature = await hmac(signKey, `sha1\n${keyTime}\n${await sha1(httpString)}\n`);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=${query.map(([key]) => encode(key)).join(';')}&q-signature=${signature}`;
}

function xml(text: string): Record<string, any> {
  if (text.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) {
    throw new ApiError(502, 'storage_response', 'Invalid storage XML response');
  }
  try { return parser.parse(text); } catch { throw new ApiError(502, 'storage_response', 'Invalid storage XML response'); }
}

function requireXml(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ApiError(502, 'storage_response', 'Incomplete storage response');
  return value;
}

function requireNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ApiError(502, 'storage_response', 'Invalid storage object size');
  return number;
}

function errorResponse(response: Response): never {
  if (response.status === 401 || response.status === 403) throw new ApiError(502, 'storage_access_denied', 'Storage rejected the configured credentials or permissions');
  throw new ApiError(502, 'storage_error', `Storage request failed (HTTP ${response.status})`);
}

export class S3Store implements Store {
  private config: S3Config;
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  constructor(config: S3Config, env: Env) {
    this.config = config;
    const id = env[config.accessKeyIdSecret], key = env[config.secretAccessKeySecret];
    const token = config.sessionTokenSecret ? env[config.sessionTokenSecret] : undefined;
    if (typeof id !== 'string' || !id || typeof key !== 'string' || !key || (config.sessionTokenSecret && (typeof token !== 'string' || !token))) {
      throw new ApiError(503, 'storage_not_configured', 'Storage credentials are missing from Worker secrets');
    }
    this.accessKeyId = id; this.secretAccessKey = key;
    if (typeof token === 'string') this.sessionToken = token;
  }

  private url(key = '', query: Record<string, string> = {}): URL {
    // URL parsers normalize dot segments, which could escape the configured bucket in path-style mode.
    if (key.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new ApiError(400, 'invalid_request', 'S3 object keys cannot contain standalone . or .. path segments');
    }
    const url = new URL(this.config.endpoint);
    if (this.config.addressing === 'virtual') url.hostname = `${this.config.bucketName}.${url.hostname}`;
    const prefix = this.config.addressing === 'path' ? `${this.config.bucketName}/` : '';
    url.pathname = '/' + prefix + key.split('/').map(encode).join('/');
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  private async request(method: string, key = '', query: Record<string, string> = {}, headers: HeadersInit = {}, body?: BodyInit | null): Promise<Response> {
    const url = this.url(key, query);
    const signedHeaders = new Headers(headers);
    let request: Request;
    if (this.config.provider === 'cos') {
      signedHeaders.set('Authorization', await cosAuthorization(url, method, this.accessKeyId, this.secretAccessKey));
      if (this.sessionToken) signedHeaders.set('x-cos-security-token', this.sessionToken);
      request = new Request(url, { method, headers: signedHeaders, body, redirect: 'manual', ...(body ? { duplex: 'half' } : {}) } as RequestInit);
    } else {
      // S3 permits UNSIGNED-PAYLOAD over TLS; do not buffer up to 64 MiB in Worker memory.
      const aws = new AwsClient({ accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
        sessionToken: this.sessionToken, region: this.config.region, service: 's3', retries: 0 });
      request = await aws.sign(url, { method, headers: signedHeaders, body, redirect: 'manual' });
    }
    const response = await fetch(request);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ApiError(502, 'storage_redirect', 'Storage endpoint redirected the signed request; check its region and endpoint');
    }
    return response;
  }

  async list({ limit, prefix, cursor, delimiter }: Parameters<Store['list']>[0]): Promise<Page> {
    const response = await this.request('GET', '', { 'list-type': '2', 'max-keys': String(limit), prefix,
      'encoding-type': 'url', ...(delimiter ? { delimiter } : {}), ...(cursor ? { 'continuation-token': cursor } : {}) });
    if (!response.ok) errorResponse(response);
    const data = xml(await response.text()).ListBucketResult;
    if (!data || !['true', 'false'].includes(data.IsTruncated)) throw new ApiError(502, 'storage_response', 'Invalid storage listing');
    const decoded = (value: unknown) => {
      try { return decodeURIComponent(requireXml(value)); }
      catch { throw new ApiError(502, 'storage_response', 'Invalid encoded storage object key'); }
    };
    const objects = values<Record<string, unknown>>(data.Contents).map(item => {
      const uploaded = new Date(requireXml(item.LastModified));
      if (Number.isNaN(uploaded.getTime())) throw new ApiError(502, 'storage_response', 'Invalid storage modification time');
      return { key: decoded(item.Key), size: requireNumber(item.Size), etag: requireXml(item.ETag),
        uploaded: uploaded.toISOString(), contentType: 'application/octet-stream' };
    });
    const prefixes = values<Record<string, unknown>>(data.CommonPrefixes).map(item => decoded(item.Prefix));
    const truncated = data.IsTruncated === 'true';
    return { objects, prefixes, truncated, cursor: truncated ? requireXml(data.NextContinuationToken) : null };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) errorResponse(response);
    const uploaded = new Date(requireXml(response.headers.get('last-modified')));
    if (Number.isNaN(uploaded.getTime())) throw new ApiError(502, 'storage_response', 'Invalid storage modification time');
    return { key, size: requireNumber(requireXml(response.headers.get('content-length'))), etag: requireXml(response.headers.get('etag')),
      uploaded: uploaded.toISOString(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
  }

  async get(key: string, range: { offset: number; length: number } | undefined, etag: string, size: number) {
    const headers = new Headers({ 'If-Match': etag });
    if (range) headers.set('Range', `bytes=${range.offset}-${range.offset + range.length - 1}`);
    const response = await this.request('GET', key, {}, headers);
    if ([404, 412].includes(response.status)) {
      await response.body?.cancel();
      return new Response(null, { status: response.status });
    }
    if (response.status === 416) return new Response(null, { status: 412 });
    if (!response.ok) errorResponse(response);
    if (response.headers.get('etag') !== etag || response.status !== (range ? 206 : 200) ||
      (range && response.headers.get('content-range') !== `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`) ||
      Number(response.headers.get('content-length')) !== (range?.length ?? size)) {
      await response.body?.cancel();
      return new Response(null, { status: 412 });
    }
    return response;
  }

  async put(key: string, body: ReadableStream | null, size: number, type: string, headers: Headers) {
    const outgoing = new Headers({ 'Content-Type': type, 'Content-Length': String(size) });
    for (const condition of ['If-Match', 'If-None-Match']) {
      const value = headers.get(condition);
      if (value) {
        if (this.config.provider === 'cos') {
          if (condition === 'If-None-Match' && value === '*') outgoing.set('x-cos-forbid-overwrite', 'true');
          else throw new ApiError(501, 'unsupported_condition', 'COS does not support this atomic upload condition');
        } else outgoing.set(condition, value);
      }
    }
    const response = await this.request('PUT', key, {}, outgoing, body);
    if ([409, 412].includes(response.status)) return null;
    if (!response.ok) errorResponse(response);
    const object = await this.head(key);
    if (!object) throw new ApiError(502, 'storage_response', 'Uploaded object is not visible');
    return object;
  }

  async delete(key: string) {
    const response = await this.request('DELETE', key);
    if (!response.ok && response.status !== 404) errorResponse(response);
  }

  async create(key: string, type: string) {
    const response = await this.request('POST', key, { uploads: '' }, { 'Content-Type': type });
    if (!response.ok) errorResponse(response);
    return requireXml(xml(await response.text()).InitiateMultipartUploadResult?.UploadId);
  }

  async uploadPart(key: string, uploadId: string, number: number, body: ReadableStream, size: number): Promise<Part> {
    const response = await this.request('PUT', key, { uploadId, partNumber: String(number) }, { 'Content-Length': String(size) }, body);
    if (response.status === 404) throw new ApiError(409, 'upload_unavailable', 'Upload session is no longer available');
    if (!response.ok) errorResponse(response);
    return { partNumber: number, etag: requireXml(response.headers.get('etag')) };
  }

  async complete(key: string, uploadId: string, parts: Part[]): Promise<ObjectInfo> {
    const body = `<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const response = await this.request('POST', key, { uploadId }, { 'Content-Type': 'application/xml' }, body);
    if ([400, 404].includes(response.status)) throw new ApiError(409, 'upload_unavailable', 'Cannot complete upload; check session and part list');
    if (!response.ok) errorResponse(response);
    // COS and S3 may return HTTP 200 while reporting an error in the final XML chunk.
    const result = xml(await response.text());
    if (result.Error) throw new ApiError(409, 'upload_unavailable', 'Storage could not complete the upload');
    requireXml(result.CompleteMultipartUploadResult?.ETag);
    const object = await this.head(key);
    if (!object) throw new ApiError(502, 'storage_response', 'Completed object is not visible');
    return object;
  }

  async abort(key: string, uploadId: string) {
    const response = await this.request('DELETE', key, { uploadId });
    if (response.status === 404) throw new ApiError(409, 'upload_unavailable', 'Upload session is no longer available');
    if (!response.ok) errorResponse(response);
  }
}
