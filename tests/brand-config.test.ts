import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { migrateBrandConfig } from '../scripts/migrate-brand-config.mjs';

test('brand migration preserves secrets, custom paths and original backup; repeat is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dx-brand-'));
  try {
    const file = join(dir, '.env');
    const original = 'ALGO_DB_PATH="other data/custom.sqlite"\nexport ALGO_COOKIE_LUOGU="literal_ALGO_secret"\n# ALGO_CF_API_KEY=\n';
    writeFileSync(file, original);
    assert.equal(migrateBrandConfig(file).keys, 2);
    const values = parseEnv(readFileSync(file, 'utf8'));
    assert.equal(values.ALGORITHM_DX_DB_PATH, 'other data/custom.sqlite');
    assert.equal(values.ALGORITHM_DX_COOKIE_LUOGU, 'literal_ALGO_secret');
    assert.ok(!Object.keys(values).some(key => key.startsWith('ALGO_')));
    const backup = readdirSync(dir).find(name => name.endsWith('.backup'))!;
    assert.equal(readFileSync(join(dir, backup), 'utf8'), original);
    assert.equal(migrateBrandConfig(file).changed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration preserves implicit legacy database and rejects conflicting keys without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dx-brand-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data/algo-observer.sqlite'), 'unchanged');
    const file = join(dir, '.env');
    migrateBrandConfig(file);
    assert.equal(parseEnv(readFileSync(file, 'utf8')).ALGORITHM_DX_DB_PATH, 'data/algo-observer.sqlite');
    assert.equal(readFileSync(join(dir, 'data/algo-observer.sqlite'), 'utf8'), 'unchanged');
    const conflict = 'ALGO_DB_PATH=one\nALGORITHM_DX_DB_PATH=two\n';
    writeFileSync(file, conflict);
    assert.throws(() => migrateBrandConfig(file), /Both old and new/);
    assert.equal(readFileSync(file, 'utf8'), conflict);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
