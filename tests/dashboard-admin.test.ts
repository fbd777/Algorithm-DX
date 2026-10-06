/**
 * Dashboard 写接口的回归测试（账号绑定 / 解绑 / 用户 / 同步）。
 *
 * 这一组盯的是几件真发生过或真会出事的事：
 * 1. **面板能写数据之后，边界必须可枚举** —— 只开放 WRITE_ROUTES 里那几个，
 *    其余路径 POST 一律 404，DELETE 一律 405。
 * 2. **同源校验**：伪造 Host（DNS rebinding）与跨站 Origin 必须被挡在 403；
 *    没带 Origin 的脚本/curl 要放行，否则命令行和测试全挂。
 * 3. **解绑会级联删提交**，所以必须显式确认，且把删掉的条数报出来。
 * 4. **凭据只回报「写进了哪个变量」**，绝不回显值本身。
 * 5. 同步走后台任务：接口立刻返回 202，同一时刻只允许一个任务。
 *
 * 测试方式是真起一个服务进程（cwd 指向临时目录，.env 也是临时的），
 * 所以不会碰真库、也不会往项目的 .env 里写东西。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, Repository } from '../src/db/database.ts';
import { BaseFetcher } from '../src/fetchers/base.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { AtCoderFetcher } from '../src/fetchers/atcoder.ts';
import { CodeforcesSyncFetcher } from '../src/fetchers/codeforces-sync.ts';
import { submission } from '../src/fetchers/common.ts';
import { isEnvVarSet } from '../src/credentials.ts';
import { SyncJobRunner } from '../src/server/sync-job.ts';
import { handleApi } from '../src/server/api.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 临时目录里的绝对路径改成正斜杠：.env 的值里不想出现反斜杠。 */
const slashed = (p: string) => p.replace(/\\/g, '/');

let dir: string;
let child: ChildProcessWithoutNullStreams;
let port: number;
let serverLog = '';

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 父进程里的 ALGO_* 绝不能漏进来：否则真凭据会被这个测试进程拿去用。
  for (const key of Object.keys(env)) if (key.startsWith('ALGO_')) delete env[key];
  return { ...env, ...extra };
}

interface Reply {
  status: number;
  body: any;
}

function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    // agent: false —— 别让 keep-alive 连接把服务器的关闭流程吊住。
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: any = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const get = (path: string) => call('GET', path);
const post = (path: string, body: unknown, headers?: Record<string, string>) => call('POST', path, { body, headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 同步是后台任务，接口返回 202，这里等它跑完。 */
async function waitForSync(timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await get('/api/sync/status');
    const job = reply.body?.job;
    if (job && job.running === false) return job;
    await sleep(200);
  }
  throw new Error('sync job did not finish in time');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'algo-dash-'));
  // 先建库并塞一个 matiji 账号：它的数据来自本地快照，所以「面板同步」这条链路
  // 可以完全不联网地跑通。
  const db = openDatabase(join(dir, 'probe.sqlite'));
  const repo = new Repository(db);
  const user = repo.createUser('Ryan', true);
  const matiji = repo.addAccount(user, 'matiji', '123');
  assert.equal(matiji, 1);
  repo.saveSubmissions(matiji, [
    submission('matiji', { submission_id: 'seed', problem_id: 'MT1000', problem_title: '本地已有的一条', status: 'AC', submitted_at: 1_600_000_000 }),
  ]);
  db.close();

  const snapshot = join(dir, 'snapshot.json');
  writeFileSync(
    snapshot,
    JSON.stringify({
      account_handle: '123',
      records: [
        { submissionId: 21, problemId: 'MT1001', judgeResultSlug: 'Accepted', submitTime: 1_700_000_000 },
        { submissionId: 22, problemId: 'MT1002', judgeResultSlug: 'WrongAnswer', submitTime: 1_700_000_100 },
      ],
    }),
  );
  writeFileSync(
    join(dir, '.env'),
    `ALGO_DB_PATH=probe.sqlite\nALGO_MATIJI_SNAPSHOT_1=${slashed(snapshot)}\n`,
    'utf8',
  );

  port = 20_000 + Math.floor(Math.random() * 20_000);
  child = spawn(process.execPath, [join(ROOT, 'src', 'server', 'server.ts'), '--port', String(port), '--db', 'probe.sqlite'], {
    cwd: dir,
    env: cleanEnv({}),
  }) as ChildProcessWithoutNullStreams;
  child.stdout.on('data', (c) => { serverLog += String(c); });
  child.stderr.on('data', (c) => { serverLog += String(c); });

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server did not start on ${port}\n${serverLog}`);
    try {
      const reply = await get('/api/meta');
      if (reply.status === 200) break;
    } catch {
      /* 还没监听 */
    }
    await sleep(150);
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    // Windows 上文件锁要等进程真的退出才释放；不肯走就硬杀，否则删不掉临时目录。
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(3000)]);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test('meta 暴露凭据平台清单，但只回报「配了没有」', () => {
  return get('/api/meta').then((reply) => {
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.credentialPlatforms, ['luogu', 'matiji', 'leetcode-cn']);
    for (const entry of reply.body.credentials) {
      assert.equal(entry.configured, false, `${entry.variable} 在临时 .env 里不该是已配置`);
      assert.equal(typeof entry.variable, 'string');
    }
    // 响应里不能出现凭据值本身 —— 这个测试目录的 .env 里就没有凭据，这里主要是防将来回归。
    assert.equal(JSON.stringify(reply.body).includes('ALGO_COOKIE_LUOGU='), false);
    assert.equal(reply.body.users.length, 1);
    assert.equal(reply.body.accounts.length, 1);
  });
});

test('绑定、重复绑定复用、以及各种拒绝路径', async () => {
  const created = await post('/api/accounts', // probe: false —— 这些 handle 是编的，联网探测必然判「不存在」。
// 测试不该依赖外网，探测本身由单独的用例（含假 HttpClient）覆盖。
{ userId: 1, platform: 'atcoder', handle: 'ProbeOne', probe: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.existing, false);
  const id = created.body.id;

  const meta = await get('/api/meta');
  assert.equal(meta.body.accounts.length, 2);

  // 面板的语义是「复用」而不是「报错」：界面上已绑定列表就在旁边。
  const again = await post('/api/accounts', // probe: false —— 这些 handle 是编的，联网探测必然判「不存在」。
// 测试不该依赖外网，探测本身由单独的用例（含假 HttpClient）覆盖。
{ userId: 1, platform: 'atcoder', handle: 'ProbeOne', probe: false });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.id, id);
  assert.equal((await get('/api/meta')).body.accounts.length, 2);

  // handle 被别的用户占着，不能悄悄接管。
  const other = await post('/api/users', { name: '别人' });
  assert.equal(other.status, 201);
  const stolen = await post('/api/accounts', { userId: other.body.id, platform: 'atcoder', handle: 'ProbeOne', probe: false });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.code, 'ACCOUNT_OWNED_BY_OTHER');
  await post('/api/users/remove', { id: other.body.id, confirm: true });

  const badUser = await post('/api/accounts', { userId: 9999, platform: 'atcoder', handle: 'Nobody' });
  assert.equal(badUser.status, 400);
  assert.equal(badUser.body.code, 'USER_NOT_FOUND');

  const badPlatform = await post('/api/accounts', { userId: 1, platform: 'nope', handle: 'whatever' });
  assert.equal(badPlatform.status, 400);
  assert.equal(badPlatform.body.code, 'PLATFORM_UNKNOWN');

  // 洛谷只认数字 UID；填昵称要给出能看懂的中文提示。
  const badHandle = await post('/api/accounts', { userId: 1, platform: 'luogu', handle: 'tester' });
  assert.equal(badHandle.status, 400);
  assert.equal(badHandle.body.code, 'HANDLE_INVALID');
  assert.match(badHandle.body.error, /数字 ID/);

  await post('/api/accounts/unbind', { id, confirm: true });
});

test('凭据写进 .env，值不回显；非法值必须连账号一起挡住', async () => {
  const cookie = '__client_id=SECRETVALUE; _uid=999001';
  const reply = await post('/api/accounts', { userId: 1, platform: 'matiji', handle: '999001', cookie });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.credential.variable, 'ALGO_COOKIE_MATIJI');
  assert.equal(reply.body.credential.action, 'appended');
  assert.equal(JSON.stringify(reply.body).includes('SECRETVALUE'), false, '凭据值绝不能出现在响应里');
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^ALGO_COOKIE_MATIJI="__client_id=SECRETVALUE; _uid=999001"$/m);
  assert.equal(isEnvVarSet(join(dir, '.env'), 'ALGO_COOKIE_MATIJI'), true);

  const meta = await get('/api/meta');
  assert.equal(meta.body.credentials.find((c: any) => c.platform === 'matiji').configured, true);

  // 换行能让它凭空造出一个新变量，等于把「填凭据」变成「改写程序配置」。
  const before = (await get('/api/meta')).body.accounts.length;
  const injected = await post('/api/accounts', { userId: 1, platform: 'matiji', handle: '999002', cookie: 'x\nALGO_DB_PATH=/tmp/evil' });
  assert.equal(injected.status, 400);
  assert.equal(injected.body.code, 'CREDENTIAL_INVALID');
  assert.equal((await get('/api/meta')).body.accounts.length, before, '凭据不合法时不能留下半个账号');
  assert.equal(readFileSync(join(dir, '.env'), 'utf8').includes('ALGO_DB_PATH=/tmp/evil'), false);

  // 公开接口平台不需要凭据，给了一律拒绝，而不是写进一个用不上的变量名。
  const wrongPlatform = await post('/api/accounts', { userId: 1, platform: 'atcoder', handle: 'WithCookie', cookie: 'x=1' });
  assert.equal(wrongPlatform.status, 400);
  assert.equal(wrongPlatform.body.code, 'CREDENTIAL_NOT_APPLICABLE');
});

test('用户可增可删；删用户会报出连带删掉的账号数', async () => {
  const created = await post('/api/users', { name: '观测对象' });
  assert.equal(created.status, 201);
  await post('/api/accounts', { userId: created.body.id, platform: 'codeforces', handle: 'watched_one', probe: false });

  const noConfirm = await post('/api/users/remove', { id: created.body.id });
  assert.equal(noConfirm.status, 400);

  const removed = await post('/api/users/remove', { id: created.body.id, confirm: true });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, 1);
  assert.equal(removed.body.accounts, 1, '要报出被连带删掉的账号数');

  // 重复 is_self 走部分唯一索引，要翻译成人话而不是抛 SQL 错误。
  const self = await post('/api/users', { name: '另一个我', isSelf: true });
  assert.equal(self.status, 409);
  assert.equal(self.body.code, 'SELF_ALREADY_SET');
});

test('解绑必须显式确认，并把连带删掉的提交条数报出来', async () => {
  const created = await post('/api/accounts', { userId: 1, platform: 'matiji', handle: '456' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  // 造两条提交，验证级联删除写得对。
  const db = openDatabase(join(dir, 'probe.sqlite'));
  try {
    new Repository(db).saveSubmissions(id, [
      submission('matiji', { submission_id: 'a', problem_id: 'MT2001', problem_title: '甲', status: 'AC', submitted_at: 1_700_000_200 }),
      submission('matiji', { submission_id: 'b', problem_id: 'MT2002', problem_title: '乙', status: 'AC', submitted_at: 1_700_000_300 }),
    ]);
  } finally {
    db.close();
  }

  const refused = await post('/api/accounts/unbind', { id });
  assert.equal(refused.status, 400);
  assert.equal((await get('/api/meta')).body.accounts.some((a: any) => a.id === id), true);

  const removed = await post('/api/accounts/unbind', { id, confirm: true });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, 1);
  assert.equal(removed.body.submissions, 2);

  const missing = await post('/api/accounts/unbind', { id, confirm: true });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ACCOUNT_NOT_FOUND');
});

test('同源校验挡住伪造 Host 与跨站 Origin，但放行脚本', async () => {
  const foreignHost = await call('GET', '/api/meta', { headers: { Host: 'evil.example.com' } });
  assert.equal(foreignHost.status, 403, 'DNS rebinding 的 Host 不是回环地址，必须挡住');

  const reboundMeta = await call('GET', '/api/meta', { headers: { Host: 'evil.example.com' } });
  assert.equal(reboundMeta.status, 403);

  const crossOrigin = await post('/api/accounts', { userId: 1, platform: 'atcoder', handle: 'CrossSite', probe: false }, { Origin: 'http://evil.example.com' });
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = await post('/api/accounts', { userId: 1, platform: 'atcoder', handle: 'CrossSite', probe: false }, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(sameOrigin.status, 201);
  await post('/api/accounts/unbind', { id: sameOrigin.body.id, confirm: true });
});

/**
 * 探测是**三态**的：`missing` 才能据此拒绝绑定，`unknown` 只能报出来、不能挡人。
 * 这里用假 HttpClient 把三种都造一遍 —— 真联网的测试既慢又不稳定。
 */
test('改标识保留历史；关注可来回切，本人不能取消关注', async () => {
  const created = await post('/api/users', { name: '观测对象' });
  assert.equal(created.status, 201);
  const userId = created.body.id;
  const bound = await post('/api/accounts', { userId, platform: 'codeforces', handle: 'watched_two', probe: false });
  assert.equal(bound.status, 201);
  const accountId = bound.body.id;

  // 改标识：前后两个值都回报，并且把「保留了多少条提交」显式说清楚 ——
  // 这一条就是它和解绑重绑的区别。
  const renamed = await post('/api/accounts/rename', { id: accountId, handle: 'watched_two_v2', sameIdentity: true });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.from, 'watched_two');
  assert.equal(renamed.body.to, 'watched_two_v2');
  assert.equal(renamed.body.submissions, 0, '这里本来没提交，改名不该凭空造出来');

  // 洛谷只认数字 ID：改标识走的是同一套校验，不能因为「只是改个名」就放宽。
  const luogu = await post('/api/accounts', { userId, platform: 'luogu', handle: '1000001', probe: false });
  assert.equal(luogu.status, 201);
  const badRename = await post('/api/accounts/rename', { id: luogu.body.id, handle: '不是数字' });
  assert.equal(badRename.status, 400);
  assert.equal(badRename.body.code, 'HANDLE_INVALID');

  // 同一平台里别人已占用的标识要被挡住，而不是悄悄覆盖掉那个账号。
  // 唯一性是 (platform, handle_key)，不同平台各有一套 handle —— 所以冲突必须造在**同一平台**。
  const taken = await post('/api/accounts', { userId, platform: 'codeforces', handle: 'taken_cf', probe: false });
  assert.equal(taken.status, 201);
  const clash = await post('/api/accounts/rename', { id: accountId, handle: 'taken_cf' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'HANDLE_TAKEN');

  // 关注可来回切，切完数据还在（删用户才是不可逆的那个操作）。
  const off = await post('/api/users/follow', { id: userId, followed: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.is_followed, false);
  const meta = await get('/api/meta');
  assert.equal(meta.body.users.find((u: any) => u.id === userId).is_followed, false);
  // 上面一共绑了三个：watched_two_v2 / 洛谷 1000001 / taken_cf。
  assert.equal(meta.body.users.find((u: any) => u.id === userId).account_count, 3, '取消关注不删账号');
  const on = await post('/api/users/follow', { id: userId, followed: true });
  assert.equal(on.body.is_followed, true);

  // 本人是主视图与 DX 榜的锚点，不能取消关注。
  const selfOff = await post('/api/users/follow', { id: 1, followed: false });
  assert.equal(selfOff.status, 409);
  assert.equal(selfOff.body.code, 'SELF_CANNOT_UNFOLLOW');

  await post('/api/users/remove', { id: userId, confirm: true });
});

test('绑定前探测：只有平台明确说「没有」才拒绝，探不到的一律放行', async () => {
  const mem = openDatabase(':memory:');
  try {
    const stub = (status: number, body = '') =>
      (async () => new Response(body, { status })) as unknown as typeof fetch;
    const http = (status: number, body = '') => new HttpClient(mem, stub(status, body), async () => undefined);

    // AtCoder：个人主页 404 是平台自己给出的结论。
    assert.equal((await new AtCoderFetcher(http(404)).probe_handle('nobody')).status, 'missing');
    // 503 是「这次被挡了」。拿它当 missing 会挡住合法绑定 —— 这是这组测试真正守的东西。
    assert.equal((await new AtCoderFetcher(http(503)).probe_handle('someone')).status, 'unknown');
    assert.equal((await new AtCoderFetcher(http(200)).probe_handle('someone')).status, 'found');

    // Codeforces：官方 API 的 400 + comment 才是「没有这个人」。
    const cf = (status: number, body: string) => new CodeforcesSyncFetcher(new Repository(mem), http(status, body));
    assert.equal((await cf(200, '{"status":"OK","result":[{"handle":"tester"}]}').probe_handle('tester')).status, 'found');
    assert.equal(
      (await cf(400, '{"status":"FAILED","comment":"handles: User with handle nope not found"}').probe_handle('nope')).status,
      'missing',
    );
    // 同样是 400，但 comment 没说 not found —— 那是请求本身的问题，不能当「人不存在」。
    assert.equal((await cf(400, '{"status":"FAILED","comment":"handles: Field is invalid"}').probe_handle('x')).status, 'unknown');

    // 没有公开查询能力的平台干脆不探：默认 unknown，既不联网也不误判。
    class NoLookup extends BaseFetcher {
      readonly platform = 'matiji';
      async fetch_recent_submissions(): Promise<never[]> {
        return [];
      }
    }
    assert.equal((await new NoLookup().probe_handle('456')).status, 'unknown');
  } finally {
    mem.close();
  }
});

test('写端点之外的路径一律拒绝', async () => {
  const notWrite = await post('/api/stats', {});
  assert.equal(notWrite.status, 404);
  const wrongMethod = await call('DELETE', '/api/stats');
  assert.equal(wrongMethod.status, 405);
  const unknown = await post('/api/nope', {});
  assert.equal(unknown.status, 404);
  // 读接口仍然只接受 GET。
  const head = await call('HEAD', '/api/meta');
  assert.equal(head.status, 200);
});

test('面板同步：后台任务、参数校验、以及结果真的入库', async () => {
  const badAccount = await post('/api/sync', { accountId: 99_999 });
  assert.equal(badAccount.status, 400);
  const badMode = await post('/api/sync', { mode: 'whatever' });
  assert.equal(badMode.status, 400);

  const started = await post('/api/sync', { accountId: 1, mode: 'recent' });
  assert.equal(started.status, 202);
  assert.equal(started.body.job.running, true);

  const job = await waitForSync();
  assert.equal(job.error, null);
  assert.equal(job.results.length, 1);
  assert.equal(job.results[0].status, 'success');
  assert.equal(job.results[0].inserted, 2, '快照里两条都要入库');

  const meta = await get('/api/meta');
  const account = meta.body.accounts.find((a: any) => a.id === 1);
  assert.equal(account.stored_submissions, 3, '原有的 1 条 + 快照里的 2 条');
  assert.match(account.coverage.note, /码蹄集本地导入/);
  assert.equal(account.coverage.source, 'local Matiji snapshot');

  // 最近同步记录也要能被面板读到。
  const status = await get('/api/sync/status');
  assert.equal(status.body.runs.length >= 1, true);
  assert.equal(status.body.runs[0].account_id, 1);
});

/**
 * 撞上「已经有一轮同步在跑」时，409 必须把那个任务交回来。
 *
 * 这是真发生过的顺序：首页点全平台同步（CF → 洛谷 → 力扣要走二十多秒），
 * 还没跑完又到 DX 页点同步。若只回一句「等它结束再开始」，使用者只能反复点重试 ——
 * 而重试的结果是「本机已经是最新」，看起来跟没同步一模一样。
 * 拿到 job.id 前端就能跟着那轮跑到完，所以这个字段不是可选项。
 */
test('同步撞车时 409 要带上正在跑的那个任务，让前端跟它跑完', async () => {
  const db = openDatabase(':memory:');
  try {
    const runningJob = {
      id: 7, running: true, accountId: null, mode: 'recent', force: false,
      startedAt: 0, finishedAt: null, results: null, error: null,
    };
    const fake = {
      start: () => { throw new Error('ALREADY_RUNNING'); },
      state: () => runningJob,
      busy: () => true,
    } as unknown as SyncJobRunner;
    const ctx = {
      db, dbPath: 'conflict.sqlite', platforms: ['codeforces'],
      envFile: join(dir, '.env'), openWrite: () => db, syncJobs: fake,
    };
    const conflict = await handleApi(ctx, {
      method: 'POST', pathname: '/api/sync', params: new URLSearchParams(), body: { mode: 'recent' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'SYNC_ALREADY_RUNNING');
    assert.equal(conflict.body.job.id, 7, '409 必须带上正在跑的任务 id，前端才能跟着它跑完');

    // state() 说没有在跑（例如任务刚结束的那一瞬）时，不能编一个 job 出来，
    // 否则前端会去等一个永远等不到的任务 —— 退回普通冲突。
    const idle = await handleApi(
      { ...ctx, syncJobs: { ...fake, state: () => ({ ...runningJob, running: false }) } as unknown as SyncJobRunner },
      { method: 'POST', pathname: '/api/sync', params: new URLSearchParams(), body: { mode: 'recent' } },
    );
    assert.equal(idle.status, 409);
    assert.equal(idle.body.job, undefined);
    assert.match(idle.body.error, /等它结束再开始/);
  } finally {
    db.close();
  }
});

test('同步任务同一时刻只允许一个', () => {
  const db = openDatabase(':memory:');
  try {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new SyncJobRunner(() => db);
    // 用一个不会真的跑同步的替身：直接把私有方法换成等待 gate。
    (runner as any).run = async (job: any) => {
      await gate;
      job.running = false;
      job.finishedAt = 0;
    };
    const job = runner.start({ accountId: null, mode: 'recent', force: false });
    assert.equal(job.running, true);
    assert.equal(runner.busy(), true);
    assert.throws(() => runner.start({ accountId: null, mode: 'recent', force: false }), /ALREADY_RUNNING/);
    release();
  } finally {
    db.close();
  }
});


test('网页导入接收超过 16 KB 的完整文件，并保留同源保护', async () => {
  const user = await post('/api/users', { name:'网页导入测试' });
  const account = await post('/api/accounts', { userId:user.body.id, platform:'matiji', handle:'999003', probe:false });
  assert.equal(account.status,201);
  const payload = { accountId:account.body.id, snapshot:{account_handle:'999003',records:Array.from({length:200},(_,i)=>({submissionId:'web-'+i,problemId:'MT'+i,problemTitle:'导入题目',judgeResultSlug:'Accepted',submitTime:1700000000+i}))},commit:false };
  assert.ok(Buffer.byteLength(JSON.stringify(payload))>16*1024);
  const denied = await post('/api/import/matiji',payload,{Origin:'https://example.com'});
  assert.equal(denied.status,403);
  const preview = await post('/api/import/matiji',payload);
  assert.equal(preview.status,200); assert.equal(preview.body.unique,200);
  const imported = await post('/api/import/matiji',{...payload,commit:true});
  assert.equal(imported.status,200);assert.equal(imported.body.inserted,200);
  const repeated = await post('/api/import/matiji',{...payload,commit:true});
  assert.equal(repeated.body.inserted,0);
  const meta=await get('/api/meta');
  const updated=meta.body.accounts.find((a:any)=>a.id===account.body.id);
  assert.equal(updated.prerequisite,null);assert.equal(updated.stored_submissions,200);
});


test('CF Group configuration keeps secrets private, validates links and can disable extra sync', async () => {
  const user=await post('/api/users',{name:'CF Group config test'});
  const account=await post('/api/accounts',{userId:user.body.id,platform:'codeforces',handle:'GroupConfigTest',probe:false});
  assert.equal(account.status,201);
  const endpoint='/api/accounts/cf-groups', key='TestGroupKey123', secret='TestGroupSecret123';
  const payload={accountId:account.body.id,links:'https://codeforces.com/group/0doN9wUJK1/contest/720850/standings/groupmates/true',key,secret};
  assert.equal((await post(endpoint,payload,{Origin:'https://example.com'})).status,403);
  const saved=await post(endpoint,payload);assert.equal(saved.status,200);
  assert.equal(saved.body.groups[0],'https://codeforces.com/group/0doN9wUJK1/contest/720850');
  let meta=await get('/api/meta');
  const serialized=JSON.stringify(meta.body);assert.ok(!serialized.includes(key));assert.ok(!serialized.includes(secret));
  assert.equal(meta.body.accounts.find((a:any)=>a.id===account.body.id).cfAuthorized,true);
  const bad=await post(endpoint,{...payload,links:'https://example.com/group/a/contest/1'});assert.equal(bad.status,400);
  const disabled=await post(endpoint,{accountId:account.body.id,links:'',key:'',secret:''});assert.equal(disabled.status,200);
  meta=await get('/api/meta');assert.deepEqual(meta.body.accounts.find((a:any)=>a.id===account.body.id).cfGroups,[]);
});

test('CF browser settings need no API key, expose mode and reject cross-origin browser launch', async () => {
 const user=await post('/api/users',{name:'CF Browser config test'});
 const account=await post('/api/accounts',{userId:user.body.id,platform:'codeforces',handle:'BrowserConfigTest',probe:false});
 const payload={accountId:account.body.id,links:'https://codeforces.com/group/abc/contests',mode:'browser'};
 assert.equal((await post('/api/accounts/cf-groups',payload)).status,200);
 const meta=await get('/api/meta');assert.equal(meta.body.accounts.find((a:any)=>a.id===account.body.id).cfGroupMode,'browser');
 assert.equal((await post('/api/accounts/cf-groups',{...payload,mode:'invalid'})).status,400);
 assert.equal((await post('/api/accounts/cf-browser',{}, {Origin:'https://example.com'})).status,403);
});

test('extension pairing requires dashboard origin and transport requires a valid token',async()=>{
 const endpoint='/api/cf-extension/pair',origin='chrome-extension://'+'a'.repeat(32);
 assert.equal((await post(endpoint,{}, {Origin:origin})).status,403);
 const paired=await post(endpoint,{});assert.equal(paired.status,200);assert.match(paired.body.token,/^[a-f0-9]{64}$/);
 assert.equal((await post('/api/cf-extension/result',{id:'unknown'}, {Origin:origin})).status,401);
 assert.equal((await post('/api/cf-extension/result',{id:'unknown'}, {Origin:'https://example.com',Authorization:'Bearer '+paired.body.token})).status,403);
 const accepted=await post('/api/cf-extension/result',{id:'unknown'}, {Origin:origin,Authorization:'Bearer '+paired.body.token});assert.equal(accepted.status,200);assert.equal(accepted.body.accepted,false);
 const meta=await get('/api/meta');assert.ok(!JSON.stringify(meta.body).includes(paired.body.token));
 const rotated=await post(endpoint,{});assert.notEqual(rotated.body.token,paired.body.token);
 assert.equal((await post('/api/cf-extension/result',{id:'unknown'}, {Origin:origin,Authorization:'Bearer '+paired.body.token})).status,401);
});
