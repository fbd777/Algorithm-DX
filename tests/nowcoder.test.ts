import test from 'node:test';
import assert from 'node:assert/strict';
import { NowcoderFetcher, parseNowcoder } from '../src/fetchers/nowcoder.ts';
import { validateAccount, historyCapability, missingPrerequisite } from '../src/fetchers/registry.ts';
const row = (id: number, result='答案正确') => '<tr><td><a href="/acm/contest/view-submission?submissionId='+id+'">'+id+'</a></td><td><a href="/acm/problem/100">A &amp; B</a></td><td>'+result+'</td><td>100</td><td>8</td><td>8264</td><td>50</td><td>C++</td><td>2026-08-17 23:46:11</td></tr>';
const page = (rows: string, pages=1) => '<table><thead>运行ID 使用语言 提交时间</thead><tbody>'+rows+'</tbody></table><ul data-total="'+pages+'"></ul>';
test('Nowcoder parses public HTML records and Beijing timestamps', () => {
  const data = parseNowcoder(page(row(1)+row(2,'运行超时')+row(3,'未知结果'),3));
  assert.equal(data.pages,3); assert.equal(data.rows[0].problem_title,'A & B');
  assert.equal(data.rows[0].submitted_at,Date.parse('2026-08-17T15:46:11Z')/1000);
  assert.equal(data.rows[0].problem_id,'100'); assert.equal(data.rows[0].memory,8264);
  assert.deepEqual(data.rows.map(r=>r.status),['AC','TLE','OTHER']);
  assert.equal(data.rows[0].difficulty,null);
});
test('Nowcoder rejects login/challenge pages and malformed rows instead of claiming complete history', () => {
  assert.throws(()=>parseNowcoder('<html>请登录</html>'));
  assert.throws(()=>parseNowcoder(page('<tr><td>unexpected</td></tr>')));
  assert.equal(parseNowcoder(page('<tr><td colspan="9">暂无记录</td></tr>')).rows.length,0);
});

test('Nowcoder recognizes the actual empty page with an omitted tbody closing tag', () => {
  const html = '<table><thead>运行ID 使用语言 提交时间</thead><tbody><tr><td colspan="1024"><div><p>没有找到你想要的内容呢￣□￣｜｜</p></div></td></tr></table>';
  assert.deepEqual(parseNowcoder(html), { rows: [], pages: 1 });
  assert.throws(() => parseNowcoder(html.replace('没有找到你想要的内容呢￣□￣｜｜', '请登录后查看')));
});
test('Nowcoder backfill continues with ascending page cursor and recent sync respects limit', async () => {
  const urls: URL[]=[];
  const http = { text: async (url: URL) => { urls.push(url); return page(row(Number(url.searchParams.get('page'))),3); } } as any;
  const fetcher=new NowcoderFetcher(http);
  const a=await fetcher.fetch_batch('123',{mode:'backfill',maxPages:2});
  assert.equal(a.complete,false); assert.equal(a.nextCursor,'3'); assert.equal(a.submissions.length,2);
  assert.equal(urls[0].searchParams.get('orderType'),'ASC');
  const b=await fetcher.fetch_batch('123',{mode:'backfill',cursor:a.nextCursor,maxPages:2});
  assert.equal(b.complete,true); assert.equal(b.nextCursor,null); assert.equal(b.submissions[0].submission_id,'3');
  const recent=await fetcher.fetch_batch('123',{limit:1});
  assert.equal(recent.submissions.length,1); assert.equal(recent.complete,false);
  assert.equal(urls.at(-1)!.searchParams.get('orderType'),'DESC');
});
test('Nowcoder stalls fail safely; stable numeric identity and no credential requirement', async () => {
  const fetcher=new NowcoderFetcher({text:async()=>page(row(1),3)} as any);
  await assert.rejects(fetcher.fetch_batch('123',{mode:'backfill',maxPages:3}),/分页未前进/);
  validateAccount('nowcoder','123'); assert.throws(()=>validateAccount('nowcoder','nickname'));
  assert.equal(historyCapability('nowcoder').supported,true);
  assert.equal(missingPrerequisite({}, {id:1,platform:'nowcoder'}),null);
});
