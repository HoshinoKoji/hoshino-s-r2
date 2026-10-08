export interface ObjectInfo { key: string; size: number; etag: string; uploaded: string; contentType: string }
export interface BucketInfo { id: string; label: string }
export interface Page { objects: ObjectInfo[]; prefixes: string[]; truncated: boolean; cursor: string | null }

export function endpoint(bucket: string, route: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params);
  return `/api/v1/buckets/${encodeURIComponent(bucket)}/${route}${query.size ? '?' + query : ''}`;
}

export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = ((await response.json()) as { error?: { message: string } }).error?.message ?? message; } catch { /* Access can return non-JSON errors. */ }
    throw new RequestError(message, response.status);
  }
  return response;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init);
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('登录状态已失效，请刷新页面重新登录');
  return response.json();
}

export function json(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

export const sizeText = (size: number) => {
  if (size < 1024) return `${size} B`;
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** index).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`;
};

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function command(bucket: string, key: string, kind: 'curl' | 'aria2' = 'curl') {
  const url = new URL(endpoint(bucket, 'object', { key }), location.origin).href;
  const filename = key.split('/').pop() || 'download';
  const headers = ['CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID', 'CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET'];
  if (kind === 'aria2') return `aria2c --continue=true --split=4 --max-connection-per-server=4 --auto-file-renaming=false --out=${quote(filename)} --header="${headers[0]}" --header="${headers[1]}" ${quote(url)}`;
  return `curl --fail --show-error --continue-at - --output ${quote(filename)} -H "${headers[0]}" -H "${headers[1]}" ${quote(url)}`;
}
