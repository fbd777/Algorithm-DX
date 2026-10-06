import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { FetchError } from './base.ts';

/** 一次请求的结果：正文、需要跟进的挑战重定向，或可重试的失败。 */
type Attempt =
  | { kind: 'ok'; text: string; status: number }
  | { kind: 'redirect'; setCookies: string[] }
  | { kind: 'failure'; error: FetchError; retryAfterMs: number };

function readSetCookies(response: Response): string[] {
  const withGetter = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

export class HttpClient {
  db: DatabaseSync;
  request: typeof fetch;
  wait: (ms: number) => Promise<unknown>;
  /** 挑战 Cookie 按域名保存在进程内，跨请求复用，避免每次都重走一轮重定向。 */
  challenge: Map<string, Map<string, string>> = new Map();
  signal?: AbortSignal;
  constructor(db: DatabaseSync, request: typeof fetch = fetch, wait = sleep, signal?: AbortSignal) {
    this.db = db; this.request = request; this.signal = signal;
    this.wait = async ms => {
      signal?.throwIfAborted();
      if (signal) return sleep(ms, undefined, { signal });
      return wait(ms);
    };
  }
  /** 在数据库里原子地占用一个请求时间片，实现跨进程的同域名限速。 */
  private async reserve(origin: string, intervalMs: number): Promise<void> {
    this.signal?.throwIfAborted();
    // Reserve a request slot atomically, including across CLI processes sharing this DB.
    this.db.exec('BEGIN IMMEDIATE');
    let slot: number;
    try {
      const old = this.db.prepare('SELECT next_at FROM request_slots WHERE origin=?').get(origin);
      slot = Math.max(Date.now(), Number(old?.next_at ?? 0));
      this.db.prepare('INSERT INTO request_slots VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET next_at=excluded.next_at').run(origin,slot+intervalMs);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    await this.wait(Math.max(0,slot-Date.now()));
  }
  /**
   * 发一次请求并判读结果。
   * - 永久错误（登录墙、限流过长、格式不符）直接抛出；
   * - 可重试的失败（网络错误、429、5xx）返回 failure，交给调用方决定退避后是否重试；
   * - 仅当 init.redirect === 'manual' 时才把 3xx 交还给调用方，否则由 fetch 自己报错。
   */
  private async attempt(url: string | URL, init: RequestInit, intervalMs: number, raw = false): Promise<Attempt> {
    const origin = new URL(url).origin;
    await this.reserve(origin, intervalMs);
    let retryAfterMs = 0;
    try {
      const signals = [AbortSignal.timeout(15000), this.signal, init.signal].filter((s): s is AbortSignal => Boolean(s));
      const response = await this.request(url, { ...init, signal:AbortSignal.any(signals) });
      if (init.redirect === 'manual' && response.status >= 300 && response.status < 400) {
        return { kind:'redirect', setCookies:readSetCookies(response) };
      }
      // raw = 探测模式：4xx / 5xx 也要把状态码与正文交回去，由调用方自己判读 ——
      // 「平台明确说没这个人」和「这次请求没成功」是两种完全不同的结论，
      // 而普通请求没有这个需求，一律按错误处理。
      if (raw) return { kind:'ok', text: await response.text(), status: response.status };
      if (response.status === 401 || response.status === 403) throw new FetchError(`${origin}: login required or access denied (HTTP ${response.status})`,false,'AUTH_REQUIRED');
      if (!response.ok) {
        const retryHeader = response.headers.get('retry-after');
        if (retryHeader) retryAfterMs = /^\d+$/.test(retryHeader) ? Number(retryHeader)*1000 : Math.max(0,Date.parse(retryHeader)-Date.now());
        if (retryAfterMs > 60000) throw new FetchError(`${origin}: rate limited; retry on the next sync`,false,'RATE_LIMITED');
        throw new FetchError(`${origin}: HTTP ${response.status}`,response.status === 429 || response.status >= 500,'HTTP_ERROR');
      }
      return { kind:'ok', text: await response.text(), status: response.status };
    } catch (error) {
      this.signal?.throwIfAborted();
      init.signal?.throwIfAborted();
      const transient = error instanceof FetchError ? error.retryable : error instanceof TypeError || (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name));
      const wrapped = error instanceof FetchError ? error : new FetchError(`${origin}: network request failed`,false,'NETWORK_ERROR');
      if (!transient) throw wrapped;
      return { kind:'failure', error:wrapped, retryAfterMs };
    }
  }
  async text(url: string | URL, init: RequestInit = {}, intervalMs = 2100): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.attempt(url,{ ...init, redirect:'error' },intervalMs);
      if (result.kind === 'ok') return result.text;
      // redirect:'error' 会让 fetch 自己抛错，这里只作防御。
      if (result.kind === 'redirect') throw new FetchError(`${new URL(url).origin}: unexpected redirect`,false,'HTTP_ERROR');
      if (attempt === 2) throw result.error;
      await this.wait(Math.max(retryAfterMsOf(result),2100*2**attempt));
    }
    throw new FetchError('Request failed');
  }
  /**
   * 探测专用：把**状态码与正文一起**交回来，只在网络层失败时才抛。
   *
   * 与 text / json 的区别是刻意的：那两个把 4xx 当错误直接抛掉，而探测恰恰要靠 4xx
   * 区分「平台明确说没这个人」与「这次请求没成功」—— 前者可以据此拒绝绑定，后者不能。
   *
   * 不重试：探测是低频、单次的操作，探不到就报 `unknown` 让用户知道，
   * 不值得为它退避三轮（每次退避都会占用该域名的限速时间片）。
   */
  async peek(url: string | URL, init: RequestInit = {}, intervalMs = 2100): Promise<{ status: number; text: string }> {
    const result = await this.attempt(url, { ...init, redirect: 'error' }, intervalMs, true);
    if (result.kind === 'ok') return { status: result.status, text: result.text };
    // redirect:'error' 会让 fetch 自己抛错走 failure 分支，这里只作防御。
    if (result.kind === 'redirect') throw new FetchError(`${new URL(url).origin}: unexpected redirect`, false, 'HTTP_ERROR');
    throw result.error;
  }
  /**
   * 面向带反爬挑战的站点：部分平台（洛谷实测如此）会先回 302 并只在 Set-Cookie 里下发
   * 挑战值，带上该值重试才返回正文。默认的 redirect:'error' 会把这一步变成「网络错误」，
   * 所以这类请求必须走这里，用 manual 重定向自己接管 Cookie。
   */
  async textFollowingChallenge(url: string | URL, init: RequestInit = {}, intervalMs = 2100, hops = 2): Promise<string> {
    const origin = new URL(url).origin;
    const jar = this.challenge.get(origin) ?? new Map<string,string>();
    this.challenge.set(origin, jar);
    for (let hop = 0; hop <= hops; hop++) {
      const headers = new Headers(init.headers);
      const jarCookie = [...jar].map(([k,v])=>`${k}=${v}`).join('; ');
      if (jarCookie) {
        // 追加而不是覆盖：调用方带来的登录 Cookie 必须保留，挑战值只是额外附加。
        const existing = headers.get('cookie');
        headers.set('cookie',existing ? `${existing}; ${jarCookie}` : jarCookie);
      }
      let result: Attempt;
      for (let attempt = 0; ; attempt++) {
        result = await this.attempt(url,{ ...init, headers, redirect:'manual' },intervalMs);
        if (result.kind !== 'failure' || attempt === 2) break;
        await this.wait(Math.max(retryAfterMsOf(result),2100*2**attempt));
      }
      if (result.kind === 'ok') return result.text;
      if (result.kind === 'failure') throw result.error;
      let learned = false;
      for (const cookie of result.setCookies) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index > 0) { jar.set(pair.slice(0,index).trim(),pair.slice(index+1).trim()); learned = true; }
      }
      if (!learned) throw new FetchError(`${origin}: redirected without a challenge cookie; the platform may have changed its bot check`,false,'CHALLENGE_FAILED');
    }
    throw new FetchError(`${origin}: challenge cookie retry did not clear the redirect`,false,'CHALLENGE_FAILED');
  }
  async json(url: string | URL, init: RequestInit = {}, intervalMs = 2100): Promise<any> {
    const text = await this.text(url,init,intervalMs);
    try { return JSON.parse(text); }
    catch { throw new FetchError('Expected JSON; platform may require login or have changed its response',false,'SCHEMA_CHANGED'); }
  }
}

function retryAfterMsOf(result: Attempt): number {
  return result.kind === 'failure' ? result.retryAfterMs : 0;
}
