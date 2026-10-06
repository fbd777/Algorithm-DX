import { cfExtensionBridge, validExtensionToken } from '../fetchers/cf-extension.ts';
import { envFor } from '../credentials.ts';
/**
 * Phase 3 Dashboard 的本地服务。
 *
 * 设计约束：
 * - 只绑定回环地址 127.0.0.1，不监听 0.0.0.0，不出网、不对外暴露。
 * - 读路径（GET）用 `PRAGMA query_only = ON` 的连接，只做 SELECT。
 * - 写路径（POST）只开放给 api.ts 里列明的几个端点，且必须先过同源校验；写连接是惰性打开的。
 * - 静态资源只从 public/ 目录读取，做路径穿越校验。
 *
 * 用法：npm run dashboard [-- --port 8787] [--db data/algo-observer.sqlite]
 */
import { spawn } from 'node:child_process';
import { parseDashboardArgs } from './options.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WRITE_ROUTES, handleApi } from './api.ts';
import { SyncJobRunner } from './sync-job.ts';
import { createTimerSync } from './timer-sync.ts';
import { platforms } from '../fetchers/registry.ts';
import { openDatabase, SCHEMA_VERSION } from '../db/database.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 写入凭据用。与 cli.ts / commands.ts 指向同一个文件，三处必须一致。 */
const ENV_FILE = '.env';
/** 请求体上限。这个面板只收几个短字段，16 KB 已远超需要。 */
const MAX_BODY_BYTES = 16 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 以只读方式打开已有数据库。刻意不复用 openDatabase()：那个入口会建表并执行迁移，
 * 而浏览查询不该改动数据。因此这里只做版本核对，不迁移。
 *
 * 版本必须与 database.ts 的 SCHEMA_VERSION 完全一致：低于它说明库还没迁移，
 * 查询会撞上缺列；高于它说明库来自更新版本的代码。两种情况都给出可执行的指引，
 * 而不是笼统地报「不支持」。
 */
function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? -1;
    if (version > SCHEMA_VERSION) {
      throw new Error(`数据库 Schema 版本是 v${version}，比当前代码支持的 v${SCHEMA_VERSION} 更新。请更新项目代码后再打开。`);
    }
    if (version < SCHEMA_VERSION) {
      throw new Error(`数据库还是 v${version}，需要先迁移到 v${SCHEMA_VERSION}。跑一次 npm run db:init 或 npm run sync 即可；面板自身不负责迁移。`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 同源校验。
 *
 * 面板现在能写数据了，所以必须挡住「别的网页替我提交表单」和 DNS rebinding：
 * - Host 必须是回环地址 —— rebinding 时浏览器发来的 Host 是攻击者的域名（只是解析到了 127.0.0.1）。
 * - 带了 Origin 就必须是回环来源 —— 跨站页面的 Origin 一定是它自己的域名。
 * - 没带 Origin 的放行 —— curl、脚本这类非浏览器客户端本来就不发这个头。
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function fromLoopback(req: IncomingMessage): boolean {
  if (!LOOPBACK.test(String(req.headers.host ?? ''))) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return LOOPBACK_ORIGIN.test(String(origin));
}

function sendJson(res: ServerResponse, status: number, body: unknown, downloadName?: string): void {
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

/** 读取并解析 JSON 请求体；超过上限直接放弃，不继续往内存里读。 */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (type && !type.includes('application/json')) throw new Error('请求体必须是 application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

/** 把 URL 路径解析到 public/ 内的真实文件；越界返回 null。 */
function resolveStatic(pathname: string): string | null {
  if (pathname === '/brand/logo.png') {
    const logo = join(PROJECT_ROOT, 'logo.png');
    return existsSync(logo) ? logo : null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.includes('\0')) return null;
  const target = normalize(join(PUBLIC_DIR, relative));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const file = resolveStatic(pathname);
  if (!file) {
    const notFound = JSON.stringify({ error: `找不到资源：${pathname}` });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(notFound);
    return;
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function main(): void {
  // 与 cli.ts 保持一致：面板同样要认 .env 里的 ALGO_DB_PATH / ALGO_DASHBOARD_PORT。
  // 命令行参数仍然优先，loadEnvFile 不会覆盖已经存在的环境变量。
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log('Usage: npm run dashboard -- [--port 8787] [--db data/algo-observer.sqlite] [--open]');
    return;
  }
  const options = parseDashboardArgs(process.argv.slice(2));
  const dbPath = resolve(options.dbPath);
  const envFile = resolve(ENV_FILE);

  if (!existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}`);
    console.error('先初始化并同步数据，例如：');
    console.error('  npm run db:init');
    console.error('  npm run algo -- user add "我" --self');
    console.error('  npm run algo -- account add <上一步返回的用户ID> codeforces <你的 handle>');
    console.error('  npm run sync');
    process.exit(1);
  }

  let db: DatabaseSync;
  try {
    db = openReadOnly(dbPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // 写连接惰性打开：只读浏览不该长期持有一把能改数据的连接。
  // 走 openDatabase 是为了与命令行共用同一套打开逻辑（WAL、外键、busy_timeout）；
  // 此时版本已经核对过，迁移那几步是空转。
  let writeDb: DatabaseSync | null = null;
  const openWrite = (): DatabaseSync => {
    if (!writeDb) writeDb = openDatabase(dbPath);
    return writeDb;
  };

  const syncJobs = new SyncJobRunner(openWrite, envFile);
  const ctx = { db, dbPath, platforms: [...platforms], envFile, openWrite, syncJobs };
  const checkTimers = createTimerSync(db, openWrite, syncJobs);
  const timerPoll = setInterval(() => {
    try { checkTimers(); } catch (error) { console.error('计时同步检查失败：', error instanceof Error ? error.message : error); }
  }, 5000);
  timerPoll.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (['/api/cf-extension/poll','/api/cf-extension/result'].includes(url.pathname)) {
      const origin=String(req.headers.origin??'');
      if(!LOOPBACK.test(String(req.headers.host??''))||(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))){sendJson(res,403,{error:'扩展来源无效'});return;}
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.writeHead(204);res.end();return;}
      if(method!=='POST'){sendJson(res,405,{error:'仅接受 POST'});return;}
      const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
      if(!validExtensionToken(envFor(envFile).ALGO_CF_EXTENSION_TOKEN,token)){sendJson(res,401,{error:'扩展连接码无效'});return;}
      let input:any;try{input=await readJsonBody(req,2*1024*1024);}catch{sendJson(res,400,{error:'扩展数据格式无效或过大'});return;}
      if(url.pathname.endsWith('/poll')){
        const controller=new AbortController();res.once('close',()=>controller.abort());
        const task=await cfExtensionBridge.poll(controller.signal);
        if(!res.destroyed)sendJson(res,200,{task});return;
      }
      if(!input||typeof input.id!=='string'||(input.error!==undefined&&typeof input.error!=='string')){sendJson(res,400,{error:'扩展结果格式无效'});return;}
      const accepted=cfExtensionBridge.complete(input.id,input.result,input.error);
      sendJson(res,200,{accepted});return;
    }
    if (!fromLoopback(req)) {
      sendJson(res, 403, { error: '只接受来自本机回环地址的请求' });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: '静态资源只接受 GET' });
        return;
      }
      serveStatic(req, res, url.pathname);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendJson(res, 405, { error: `${url.pathname} 不支持 ${method}` });
      return;
    }
    if (method === 'POST' && !WRITE_ROUTES.has(url.pathname)) {
      sendJson(res, 404, { error: `未知接口：${url.pathname}` });
      return;
    }

    let body: unknown;
    if (method === 'POST') {
      try {
        body = await readJsonBody(req, url.pathname === '/api/import/matiji' ? 11 * 1024 * 1024 : MAX_BODY_BYTES);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : '请求体读取失败' });
        return;
      }
    }

    const result = await handleApi(ctx, {
      method: method === 'HEAD' ? 'GET' : method,
      pathname: url.pathname,
      params: url.searchParams,
      body,
    });
    sendJson(res, result.status, result.body, result.downloadName);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : '服务内部错误' });
      else res.destroy();
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${options.port} 已被占用，用 --port 换一个。`);
    else console.error(`服务启动失败：${error.message}`);
    db.close();
    writeDb?.close();
    process.exit(1);
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log('Algorithm DX · Dashboard');
    console.log(`  数据库：${dbPath}`);
    console.log(`  地址：  http://127.0.0.1:${options.port}`);
    console.log('  浏览只读；账号绑定与同步只对本机回环开放。按 Ctrl+C 停止。');
    if (options.open) {
      const url = 'http://127.0.0.1:' + options.port;
      const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', "Start-Process '" + url + "'"] : [url];
      const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true });
      browser.on('error', () => console.error('无法自动打开浏览器，请手动访问：' + url));
      browser.on('exit', code => { if (code) console.error('无法自动打开浏览器，请手动访问：' + url); });
      browser.unref();
    }
  });

  const shutdown = () => {
    clearInterval(timerPoll);
    // 同步任务跑在进程里，Ctrl+C 会把它打断。库里那条 sync_lock 有 90 秒心跳，
    // 到期会自动失效，所以下次同步不会被永久挡住 —— 但正在抓的那一轮确实没了。
    if (syncJobs.busy()) console.log('注意：同步还在跑，现在退出会中断它（下次同步不受影响）。');
    server.close(() => {
      db.close();
      writeDb?.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
