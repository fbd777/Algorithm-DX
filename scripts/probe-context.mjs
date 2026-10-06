import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Run from the project root; CLI > environment > .env > defaults.
export function openProbe(argv = process.argv.slice(2)) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  let dbPath = process.env.ALGO_DB_PATH ?? 'data/algo-observer.sqlite';
  let userId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      dbPath = argv[++i];
      if (!dbPath || dbPath.startsWith('--')) throw new Error('--db requires a path');
    } else if (argv[i] === '--user') {
      userId = Number(argv[++i]);
      if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('--user requires a positive user ID');
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const user = userId === undefined
      ? db.prepare('SELECT id FROM users WHERE is_self = 1').get()
      : db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found. Configure a self user or pass --user ID.');
    return { db, userId: user.id };
  } catch (error) { db.close(); throw error; }
}
