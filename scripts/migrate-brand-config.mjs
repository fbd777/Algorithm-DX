import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// One-time migration only. Runtime code does not accept the old prefix.
export function migrateBrandConfig(file = resolve('.env')) {
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const values = parseEnv(original);
  const oldKeys = Object.keys(values).filter(key => key.startsWith('ALGO_'));
  for (const key of oldKeys) {
    if (Object.hasOwn(values, key.replace(/^ALGO_/, 'ALGORITHM_DX_'))) {
      throw new Error(`Both old and new names exist for ${key}; resolve the duplicate before migrating.`);
    }
  }
  // Change keys and commented template keys; never rewrite credential values.
  let next = original.replace(/^(\s*(?:#\s*|export\s+)?)ALGO_([A-Z0-9_]+)(\s*=)/gm, '$1ALGORITHM_DX_$2$3');
  const legacyDb = resolve(dirname(file), 'data/algo-observer.sqlite');
  if (!Object.hasOwn(values, 'ALGO_DB_PATH') && !Object.hasOwn(values, 'ALGORITHM_DX_DB_PATH') && existsSync(legacyDb)) {
    next += '\nALGORITHM_DX_DB_PATH=data/algo-observer.sqlite\n';
  }
  if (next === original) return { changed: false, keys: 0 };
  const temporary = file + '.' + randomUUID() + '.tmp';
  // This name is excluded by .env.* in .gitignore. Keep the original for recovery.
  const backup = existsSync(file) ? file + '.brand-' + randomUUID() + '.backup' : null;
  if (backup) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
  try {
    writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { changed: true, keys: oldKeys.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = migrateBrandConfig();
    console.log(result.changed ? `Migrated ${result.keys} configuration keys; existing database path and credential values preserved. Original .env backed up locally if present.` : 'Configuration already uses current names; no changes.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
