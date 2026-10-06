import { MatijiLiveFetcher } from './matiji-live.ts';
import { HttpClient } from './http.ts';

/** Resolve only an exact login nickname; never treat a different person's nickname as the current user. */
export async function resolveMatijiIdentity(input: string, http: HttpClient, cookie?: string) {
  let handle = input.trim();
  if (/^https?:\/\//i.test(handle)) {
    const url = new URL(handle);
    if (!['www.matiji.net', 'matiji.net'].includes(url.hostname) || url.port || url.username || url.password)
      throw new Error('请粘贴码蹄集个人主页链接');
    const other = url.pathname.match(/^\/(?:exam\/)?other-homepage\/([1-9]\d*)\/?$/);
    if (other) handle = other[1];
    else if (/^\/(?:exam\/)?personalcenter\/homepage\/?$/.test(url.pathname)) handle = '';
    else throw new Error('此链接不是码蹄集个人主页，请填写昵称、数字 ID 或个人主页链接');
  }
  if (/^[1-9]\d*$/.test(handle)) return { handle, displayName: null };
  if (!cookie) throw new Error('自动识别需要码蹄集登录信息，请在下方粘贴一次 Cookie 后保存；以后无需重复填写。绑定他人也可直接填写数字 ID 或他人主页链接。');
  const identity = await new MatijiLiveFetcher(http, cookie).currentAccount();
  if (handle && handle !== identity.displayName)
    throw new Error(`填写的昵称与当前登录账号「${identity.displayName || identity.handle}」不一致，未绑定。绑定自己请填写当前昵称或留空；绑定他人请填写数字 ID 或他人主页链接。`);
  return identity;
}
