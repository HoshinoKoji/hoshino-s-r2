import TOML from '@iarna/toml';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reserved = new Set(['ASSETS', 'BUCKETS', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'LOCAL_DEV', '__proto__', 'constructor', 'prototype']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration key');
    result[key] = plain(value) && plain(result[key]) ? merge(result[key], value) : value;
  }
  return result;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function makeConfig(base, override, local = false) {
  check(plain(override), 'Override must be a TOML table');
  check(Object.keys(override).every(k => ['worker', 'access', 'buckets'].includes(k)), 'Unknown override section');
  const worker = override.worker ?? {};
  const config = merge(base, worker);
  check(/^[a-z0-9][a-z0-9-]*$/.test(config.name ?? ''), 'Invalid Worker name');
  check(!('env' in worker), 'Named Wrangler environments are not supported; use a separate override');
  check(!('r2_buckets' in worker), 'Configure R2 using [[buckets]]');
  check(!('route' in config), 'Use worker.routes rather than worker.route');
  check(config.assets?.binding === 'ASSETS' && config.assets?.run_worker_first === true,
    'Assets must use ASSETS and run_worker_first = true so authentication covers all resources');
  check(!Object.keys(worker.vars ?? {}).some(k => reserved.has(k)), 'Reserved variable in worker.vars');
  if (!local) {
    check(/^[a-f0-9]{32}$/.test(config.account_id ?? ''), 'Set a valid worker.account_id');
    check(config.workers_dev === false && config.preview_urls === false, 'Disable workers_dev and preview_urls');
    check(Array.isArray(config.routes) && config.routes.length > 0, 'Set at least one worker.routes entry');
    for (const route of config.routes) {
      check(plain(route) && route.custom_domain === true && /^[a-z0-9.-]+\.[a-z]+$/i.test(route.pattern ?? ''),
        'Each route must be a custom domain hostname');
    }
  }
  const access = override.access ?? {};
  if (!local) {
    check(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(access.team_domain ?? ''), 'Invalid access.team_domain');
    check(/^[a-f0-9]{64}$/.test(access.audience ?? ''), 'Set the Access application audience (64 hex characters)');
  }
  check(Array.isArray(override.buckets) && override.buckets.length > 0, 'Configure at least one [[buckets]]');
  const ids = new Set();
  const bindings = new Set([...reserved, ...Object.keys(config.vars ?? {})]);
  // Detect conflicts with optional non-R2 bindings defined in the common/worker config.
  for (const list of Object.values(config)) {
    if (Array.isArray(list)) for (const item of list) if (item?.binding) bindings.add(item.binding);
  }
  for (const bucket of override.buckets) {
    check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bucket.id ?? ''), 'Invalid bucket id');
    check(typeof bucket.label === 'string' && bucket.label.length > 0, 'Bucket label is required');
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(bucket.binding ?? ''), 'Invalid binding name');
    check(typeof bucket.bucket_name === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.bucket_name), 'Invalid bucket_name');
    check(!ids.has(bucket.id), 'Duplicate bucket id');
    check(!bindings.has(bucket.binding), 'Duplicate or reserved binding name');
    check(!bucket.jurisdiction || ['eu', 'fedramp'].includes(bucket.jurisdiction), 'Invalid jurisdiction');
    ids.add(bucket.id);
    bindings.add(bucket.binding);
  }
  config.r2_buckets = override.buckets.map(({ binding, bucket_name, jurisdiction, preview_bucket_name }) => ({
    binding, bucket_name, ...(jurisdiction ? { jurisdiction } : {}), ...(preview_bucket_name ? { preview_bucket_name } : {}),
  }));
  config.vars = {
    ...config.vars,
    BUCKETS: override.buckets.map(({ id, label, binding }) => ({ id, label, binding })),
    ACCESS_TEAM_DOMAIN: local ? '' : access.team_domain,
    ACCESS_AUD: local ? '' : access.audience,
    LOCAL_DEV: local ? 'true' : 'false',
  };
  check(Buffer.byteLength(JSON.stringify(config.vars.BUCKETS)) <= 5000, 'Bucket mapping exceeds Worker variable size');
  if (local) {
    delete config.account_id;
    delete config.routes;
  }
  return config;
}

export async function generate(overridePath, local) {
  const base = TOML.parse(await readFile(resolve(root, 'wrangler.toml'), 'utf8'));
  let override;
  try {
    override = TOML.parse(await readFile(resolve(root, overridePath ?? 'deploy.override.toml'), 'utf8'));
  } catch (error) {
    if (!local || overridePath || error.code !== 'ENOENT') throw error;
    override = {
      buckets: [
        { id: 'documents', label: '本地文档', binding: 'R2_DOCUMENTS', bucket_name: 'local-documents' },
        { id: 'archives', label: '本地归档', binding: 'R2_ARCHIVES', bucket_name: 'local-archives' },
      ],
    };
  }
  const config = makeConfig(base, override, local);
  await writeFile(resolve(root, 'wrangler.generated.toml'), TOML.stringify(config));
  return config;
}
