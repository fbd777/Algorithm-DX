import { existsSync } from 'node:fs';
import { runCommand } from './commands.ts';

try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  await runCommand(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
}
