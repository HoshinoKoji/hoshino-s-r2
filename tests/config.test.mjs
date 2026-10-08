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
