import { test } from 'node:test';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';
import { readFile } from 'node:fs/promises';
import { makeConfig, merge } from '../scripts/config.mjs';

const base = TOML.parse(await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'));
const override = {
  worker: { name: 'fork-r2', account_id: 'a'.repeat(32), routes: [{ pattern: 'files.example.com', custom_domain: true }] },
  access: { team_domain: 'https://example.cloudflareaccess.com', audience: 'b'.repeat(64) },
  buckets: [{ id: 'photos', label: '相册', binding: 'PHOTOS', bucket_name: 'fork-photos' }],
};

test('TOML roundtrip keeps R2 bindings and application mapping aligned', () => {
  const config = TOML.parse(TOML.stringify(makeConfig(base, override)));
  assert.equal(config.name, 'fork-r2');
  assert.equal(config.main, base.main);
  assert.deepEqual(config.r2_buckets, [{ binding: 'PHOTOS', bucket_name: 'fork-photos' }]);
  assert.deepEqual(config.vars.BUCKETS, [{ id: 'photos', label: '相册', binding: 'PHOTOS' }]);
  assert.equal(config.vars.LOCAL_DEV, 'false');
});

test('tables merge and arrays replace (including empty arrays)', () => {
  assert.deepEqual(merge({ a: { b: 1, c: [1, 2] }, routes: [{ pattern: 'old' }] }, { a: { c: [] }, routes: [{ pattern: 'new' }] }),
    { a: { b: 1, c: [] }, routes: [{ pattern: 'new' }] });
});

test('configuration rejects conflicting bindings and unsafe deployment settings', () => {
  assert.throws(() => makeConfig(base, { ...override, buckets: [...override.buckets, ...override.buckets] }), /Duplicate/);
  assert.throws(() => makeConfig(base, { ...override, buckets: [{ ...override.buckets[0], binding: 'ASSETS' }] }), /reserved/);
  assert.throws(() => makeConfig(base, { ...override, worker: { ...override.worker, workers_dev: true } }), /Disable/);
  assert.throws(() => makeConfig(base, { ...override, worker: { ...override.worker, assets: { run_worker_first: false } } }), /Assets/);
  assert.throws(() => makeConfig(base, { ...override, access: { ...override.access, audience: 'placeholder' } }), /audience/);
  assert.throws(() => makeConfig(base, { ...override, worker: { ...override.worker, vars: { LOCAL_DEV: 'true' } } }), /Reserved/);
});

test('local config removes account/routes and remote auth settings', () => {
  const config = makeConfig(base, override, true);
  assert.equal(config.account_id, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.vars.LOCAL_DEV, 'true');
  assert.equal(config.vars.ACCESS_AUD, '');
});

test('R2 and COS/S3 mounts share IDs but only R2 creates Wrangler bucket bindings', () => {
  const cos = { id: 'cos', label: '腾讯 COS', type: 's3', provider: 'cos', bucket_name: 'photos-1250000000',
    endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', addressing: 'virtual',
    access_key_id_secret: 'COS_SECRET_ID', secret_access_key_secret: 'COS_SECRET_KEY' };
  const config = TOML.parse(TOML.stringify(makeConfig(base, { ...override, buckets: [...override.buckets, cos] })));
  assert.equal(config.r2_buckets.length, 1);
  assert.deepEqual(config.vars.BUCKETS[1], { id: 'cos', label: '腾讯 COS', type: 's3', provider: 'cos',
    bucketName: 'photos-1250000000', endpoint: cos.endpoint, region: 'ap-guangzhou', addressing: 'virtual',
    accessKeyIdSecret: 'COS_SECRET_ID', secretAccessKeySecret: 'COS_SECRET_KEY' });
  assert.equal(JSON.stringify(config).includes('actual-secret'), false);
  assert.equal(makeConfig(base, { ...override, buckets: [cos] }).r2_buckets.length, 0);
  assert.throws(() => makeConfig(base, { ...override, buckets: [{ ...cos, endpoint: 'http://cos.ap-guangzhou.myqcloud.com' }] }), /HTTPS/);
  assert.throws(() => makeConfig(base, { ...override, buckets: [{ ...cos, secret_access_key: 'actual-secret' }] }), /field/);
  assert.throws(() => makeConfig(base, { ...override, buckets: [{ ...cos, access_key_id_secret: 'ACCESS_AUD' }] }), /conflicts/);
  assert.throws(() => makeConfig(base, { ...override, buckets: [{ ...cos, session_token_secret: '' }] }), /session_token_secret/);
  assert.throws(() => makeConfig(base, { ...override, buckets: [...override.buckets, cos, { ...cos, id: 'other', access_key_id_secret: 'PHOTOS' }] }), /conflicts/);
  assert.equal(makeConfig(base, { ...override, buckets: [{ ...cos, endpoint: 'http://localhost:9000', addressing: 'path' }] }, true).vars.BUCKETS[0].endpoint, 'http://localhost:9000');
});
