import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve local settings relative to the downloaded project, including shortcuts.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error('Algorithm DX requires Node.js 24.15 or newer. See https://nodejs.org');
  }
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/start-local.mjs [--db PATH] [--port PORT] [--open] [--init-only]');
  } else {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const { parseDashboardArgs } = await import('../src/server/options.ts');
    const initOnly = argv.includes('--init-only');
    const serverArgs = argv.filter(arg => arg !== '--init-only');
    const options = parseDashboardArgs(serverArgs);
    const dbPath = resolve(options.dbPath);
    if (!existsSync(dbPath)) {
      const { openDatabase, Repository } = await import('../src/db/database.ts');
      const db = openDatabase(dbPath);
      try {
        new Repository(db).createUser('我', true);
        console.log('Created local database: ' + dbPath);
        console.log('Use account management in the dashboard to add your platform accounts.');
      } finally { db.close(); }
    }
    if (!initOnly) {
      // Same process: closing the launcher or Ctrl+C stops the service.
      process.argv = [process.execPath, fileURLToPath(new URL('../src/server/server.ts', import.meta.url)), ...serverArgs];
      await import('../src/server/server.ts');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
