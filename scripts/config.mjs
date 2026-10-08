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
  const secrets = new Set();
  // Detect conflicts with optional non-R2 bindings defined in the common/worker config.
  for (const list of Object.values(config)) {
    if (Array.isArray(list)) for (const item of list) if (item?.binding) bindings.add(item.binding);
  }
  for (const bucket of override.buckets) {
    check(plain(bucket), 'Each bucket must be a table');
    check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bucket.id ?? ''), 'Invalid bucket id');
    check(typeof bucket.label === 'string' && bucket.label.length > 0, 'Bucket label is required');
    const type = bucket.type ?? 'r2';
    check(['r2', 's3'].includes(type), 'Invalid bucket type');
    const fields = type === 'r2'
      ? ['id', 'label', 'type', 'binding', 'bucket_name', 'jurisdiction', 'preview_bucket_name']
      : ['id', 'label', 'type', 'provider', 'bucket_name', 'endpoint', 'region', 'addressing', 'access_key_id_secret', 'secret_access_key_secret', 'session_token_secret'];
    check(Object.keys(bucket).every(field => fields.includes(field)), `Invalid ${type} bucket field`);
    check(typeof bucket.bucket_name === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.bucket_name), 'Invalid bucket_name');
    check(!ids.has(bucket.id), 'Duplicate bucket id');
    if (type === 'r2') {
      check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(bucket.binding ?? ''), 'Invalid binding name');
      check(!bindings.has(bucket.binding) && !secrets.has(bucket.binding), 'Duplicate or reserved binding name');
      check(!bucket.jurisdiction || ['eu', 'fedramp'].includes(bucket.jurisdiction), 'Invalid jurisdiction');
      bindings.add(bucket.binding);
    } else {
      check(['s3', 'cos'].includes(bucket.provider), 'S3 provider must be s3 or cos');
      check(typeof bucket.region === 'string' && /^[a-z0-9-]{2,64}$/.test(bucket.region), 'Invalid S3 region');
      check(['path', 'virtual'].includes(bucket.addressing), 'S3 addressing must be path or virtual');
      let endpoint;
      try { endpoint = new URL(bucket.endpoint); } catch { /* validated below */ }
      check(endpoint && (endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) &&
        !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/', 'S3 endpoint must be an HTTPS service origin');
      for (const name of ['access_key_id_secret', 'secret_access_key_secret']) {
        check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(bucket[name] ?? ''), `Invalid ${name}`);
      }
      if ('session_token_secret' in bucket) check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(bucket.session_token_secret), 'Invalid session_token_secret');
      for (const name of [bucket.access_key_id_secret, bucket.secret_access_key_secret, bucket.session_token_secret].filter(Boolean)) {
        check(!bindings.has(name), 'S3 secret name conflicts with a binding or variable');
        secrets.add(name);
      }
    }
    ids.add(bucket.id);
  }
  check(![...secrets].some(name => bindings.has(name)), 'S3 secret name conflicts with a binding or variable');
  config.r2_buckets = override.buckets.filter(bucket => (bucket.type ?? 'r2') === 'r2').map(({ binding, bucket_name, jurisdiction, preview_bucket_name }) => ({
    binding, bucket_name, ...(jurisdiction ? { jurisdiction } : {}), ...(preview_bucket_name ? { preview_bucket_name } : {}),
  }));
  config.vars = {
    ...config.vars,
    BUCKETS: override.buckets.map(bucket => bucket.type === 's3'
      ? { id: bucket.id, label: bucket.label, type: 's3', provider: bucket.provider, bucketName: bucket.bucket_name,
        endpoint: bucket.endpoint, region: bucket.region, addressing: bucket.addressing,
        accessKeyIdSecret: bucket.access_key_id_secret, secretAccessKeySecret: bucket.secret_access_key_secret,
        ...(bucket.session_token_secret ? { sessionTokenSecret: bucket.session_token_secret } : {}) }
      : { id: bucket.id, label: bucket.label, binding: bucket.binding }),
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
