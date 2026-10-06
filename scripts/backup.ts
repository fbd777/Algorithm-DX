/**
 * 本地数据备份：把练习数据库快照到 data/backups/，可选导出 CSV。
 *
 * 用 SQLite 的 VACUUM INTO 生成快照，而不是直接复制 .sqlite 文件：
 * 数据库运行在 WAL 模式下，最新的提交可能还留在 -wal 文件里，
 * 单独复制主文件会得到一份缺数据的副本。VACUUM INTO 由 SQLite
 * 自己写出一份完整、自洽的单文件快照，也不会影响正在运行的面板。
 *
 * 默认不删除任何东西。要清理旧快照必须显式给 --prune N，
 * 而且只匹配本脚本自己生成的命名，不会碰目录里的其他文件。
 *
 * 用法：npm run backup [-- --csv] [--prune 10]
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, extname, join, resolve } from 'node:path';

const KEEP_BY_DEFAULT = 10;
const args = process.argv.slice(2);

function optionValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

if (existsSync('.env')) process.loadEnvFile('.env');
const dbPath = resolve(process.env.ALGORITHM_DX_DB_PATH ?? 'data/algorithm-dx.sqlite');
if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  console.error('先运行 npm run db:init 建库、npm run sync 抓取数据，再备份。');
  process.exit(1);
}

const outDir = join(dirname(dbPath), 'backups');
mkdirSync(outDir, { recursive: true });
const stem = basename(dbPath, extname(dbPath));

/**
 * 快照文件名里的一次性时间戳，精确到毫秒。
 * 只到秒的话，同一秒内连续运行两次会撞名，第二次直接失败 —— 而 --prune 的
 * 清理逻辑排在创建之后，会连带被跳过，恰好在最需要清理的时候失灵。
 */
function localStamp(date = new Date()): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`;
}

// 快照与 CSV 共用同一个戳。只有同名，--prune 才能把两者配成一对一起收掉。
const stamp = localStamp();
const target = join(outDir, `${stem}-${stamp}.sqlite`);

if (existsSync(target)) {
  console.error(`目标文件已存在，未覆盖：${target}`);
  console.error('（同一毫秒内重复运行才会出现；本次跳过创建快照，继续处理清理参数。）');
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let snapshotBytes = 0;
  try {
    // VACUUM INTO 只在目标路径写文件，源库保持只读，所以面板可以照常运行。
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    snapshotBytes = statSync(target).size;

    const counts = db
      .prepare('SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM submissions) AS submissions')
      .get() as Record<string, number>;

    console.log('备份完成');
    console.log(`  快照：${target}`);
    console.log(`  大小：${(snapshotBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  内容：${counts.users} 个用户 / ${counts.accounts} 个账号 / ${counts.submissions} 条提交`);

    if (args.includes('--csv')) {
      const rows = db
        .prepare(
          `SELECT s.platform, a.handle, a.display_name, s.submission_id, s.problem_id, s.problem_title,
                  s.difficulty, s.status, s.raw_status, s.language, s.execution_time, s.memory, s.score, s.submitted_at, s.tags_json
           FROM submissions s JOIN accounts a ON a.id = s.account_id
           ORDER BY s.submitted_at ASC, s.id ASC`,
        )
        .all() as Record<string, unknown>[];
      const header = ['platform', 'handle', 'display_name', 'submission_id', 'problem_id', 'problem_title',
        'difficulty', 'status', 'raw_status', 'language', 'execution_time_ms', 'memory_bytes', 'score', 'submitted_at_utc', 'tags'];
      const escape = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        let text = String(value);
        if (text.includes(',') || text.includes('"') || text.includes('\n')) text = `"${text.replace(/"/g, '""')}"`;
        return text;
      };
      const lines = [header.join(',')];
      for (const row of rows) {
        let tags: string[] = [];
        try { const parsed = JSON.parse(String(row.tags_json ?? '[]')); if (Array.isArray(parsed)) tags = parsed.map(String); } catch { tags = []; }
        lines.push([
          row.platform, row.handle, row.display_name, row.submission_id, row.problem_id, row.problem_title,
          row.difficulty, row.status, row.raw_status, row.language, row.execution_time, row.memory, row.score,
          new Date(Number(row.submitted_at) * 1000).toISOString(), tags.join(' '),
        ].map(escape).join(','));
      }
      const csvPath = join(outDir, `${stem}-${stamp}.csv`);
      writeFileSync(csvPath, `${lines.join('\r\n')}\r\n`, 'utf8');
      console.log(`  CSV ：${csvPath}（${rows.length} 行，UTF-8 + CRLF，Excel 可直接打开）`);
      console.log('        注意：提交时间已转成 UTC，Excel 里显示的是 UTC 而非北京时间。');
    }
  } finally {
    db.close();
  }
}

// 只认本脚本自己的命名，避免误删用户放进来的别的东西。
// 兼容旧格式（-HHMMSS）与新格式（-HHMMSSmmm），此前生成的快照也能被正确清理。
const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}(\\d{3})?\\.sqlite$`);
const existing = readdirSync(outDir).filter((name) => pattern.test(name)).sort();
const pruneRaw = optionValue('--prune');

if (pruneRaw !== null) {
  const keep = Number(pruneRaw);
  if (!Number.isSafeInteger(keep) || keep < 1) {
    console.error(`--prune 需要 ≥1 的整数，收到：${pruneRaw}`);
    process.exitCode = 1;
  } else {
    const doomed = existing.slice(0, Math.max(0, existing.length - keep));
    if (!doomed.length) console.log(`已有 ${existing.length} 份快照，无需清理（保留 ${keep} 份）。`);
    for (const name of doomed) {
      // 快照与同名的 CSV 是同一次导出的产物，一起收掉，目录才不会有孤儿文件。
      for (const fileName of [name, name.replace(/\.sqlite$/, '.csv')]) {
        const full = join(outDir, fileName);
        if (!existsSync(full)) continue;
        try { unlinkSync(full); console.log(`  已移除旧快照：${fileName}`); }
        catch (error) { console.error(`  移除失败 ${fileName}：${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
      }
    }
    if (doomed.length) console.log(`清理完成，保留最近 ${keep} 份。`);
  }
} else if (existing.length > KEEP_BY_DEFAULT) {
  console.log('');
  console.log(`提示：${outDir} 里已有 ${existing.length} 份快照，本脚本默认不删除任何文件。`);
  console.log(`      需要只保留最近 ${KEEP_BY_DEFAULT} 份时执行：npm run backup -- --prune ${KEEP_BY_DEFAULT}`);
}
