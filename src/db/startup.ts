import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from './database.ts';

/** Upgrade an existing installation before starting the HTTP server. */
export function prepareDatabaseForStartup(path: string, log: (message: string) => void = console.log): void {
  const dbPath = resolve(path);
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  let version: number;
  try { version = Number(probe.prepare('PRAGMA user_version').get()!.user_version); }
  finally { probe.close(); }

  if (version > SCHEMA_VERSION) {
    throw new Error(`数据库版本 v${version} 高于当前程序支持的 v${SCHEMA_VERSION}，请使用更新的软件包；不会降级或覆盖数据。`);
  }
  if (version === SCHEMA_VERSION) return;

  let backupPath: string | undefined;
  try {
    const db = openDatabase(dbPath, {
      beforeMigration(fromVersion) {
        log(`检测到旧数据库 v${fromVersion}，正在备份并升级到 v${SCHEMA_VERSION}…`);
        const backupDir = join(dirname(dbPath), 'backups');
        mkdirSync(backupDir, { recursive: true });
        const stem = basename(dbPath, extname(dbPath));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = join(backupDir, `${stem}-pre-v${fromVersion}-to-v${SCHEMA_VERSION}-${stamp}-${randomUUID()}.sqlite`);
        // The migration connection holds BEGIN IMMEDIATE, so other writers cannot
        // change the source between this snapshot and the migration. A separate
        // read connection includes committed WAL data and allows VACUUM INTO.
        const source = new DatabaseSync(dbPath, { readOnly: true });
        try { source.prepare('VACUUM INTO ?').run(target); }
        finally { source.close(); }
        const backup = new DatabaseSync(target, { readOnly: true });
        try {
          const checks = backup.prepare('PRAGMA quick_check').all();
          if (Number(backup.prepare('PRAGMA user_version').get()!.user_version) !== fromVersion ||
              checks.length !== 1 || checks[0].quick_check !== 'ok') {
            throw new Error('升级前备份校验失败');
          }
        } finally { backup.close(); }
        backupPath = target;
        log(`升级前备份：${backupPath}`);
      },
    });
    db.close();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const recovery = backupPath
      ? `本次迁移未提交，旧记录已保留。升级前备份：${backupPath}。如需恢复，请关闭所有程序，将现有数据库及同名 -wal/-shm 文件一起移到其他目录留存，再将备份复制到原数据库路径。`
      : '未完成升级前备份，未执行迁移。请检查目录写入权限、磁盘空间，并关闭其他正在使用此数据库的程序后重试。';
    throw new Error(`数据库自动升级失败，已停止启动。${recovery}\n原因：${reason}`, { cause: error });
  }
  if (backupPath) log(`数据库已升级到 v${SCHEMA_VERSION}，原有账号、提交和用时记录已保留。`);
}
