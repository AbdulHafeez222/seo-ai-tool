import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('backup rehearsal rejects production and non-dedicated URIs before database or tool access', () => {
  for (const uri of ['mongodb+srv://db.example/production', 'mongodb://127.0.0.1:27019/production', 'mongodb://localhost:27019/seo_beta_acceptance']) {
    const result = spawnSync(process.execPath, ['scripts/backup-rehearsal.mjs'], {
      env: { ...process.env, TEST_MONGODB_URI: uri }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated loopback replica set, never production/);
  }
});
