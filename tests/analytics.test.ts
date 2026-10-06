import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { getAnalytics } from '../src/server/analytics.ts';
import type { Filters } from '../src/server/queries.ts';
import { periodBounds, heatmapDates, shiftPeriodDate } from '../public/analytics.js';
import { difficultyLabel, languageLabel, mergeLanguages } from '../public/stat-labels.js';

const f: Filters = { platforms: [], userId: null, scope: 'me', status: 'all', q: null, since: null, until: null, tzOffsetMinutes: 480 };
const time = (s: string) => Date.parse(s) / 1000;
test('period shortcuts handle leap days, month ends and year boundaries', () => {
  assert.equal(shiftPeriodDate('day','2024-02-28',1),'2024-02-29');
  assert.equal(shiftPeriodDate('day','2026-01-01',-1),'2025-12-31');
  assert.equal(shiftPeriodDate('week','2025-12-29',1),'2026-01-05');
  assert.equal(shiftPeriodDate('month','2024-01-31',1),'2024-02-01');
  assert.equal(shiftPeriodDate('month','2024-03-31',-1),'2024-02-01');
  assert.equal(shiftPeriodDate('month','2026-12-01',1),'2027-01-01');
  assert.equal(shiftPeriodDate('year','2024-02-29',1),'2025-01-01');
  assert.throws(()=>shiftPeriodDate('day','2026-02-30',1));
});
test('platform labels decode legacy Luogu IDs and merge equivalent language names', () => {
  assert.equal(languageLabel('Luogu language #28'),'C++14 (GCC 9)');
  assert.equal(languageLabel('luogu language#7'),'Python 3');
  assert.equal(languageLabel('Luogu language #999'),'未知语言（洛谷编号 999）');
  assert.deepEqual(mergeLanguages([{label:'Luogu language #28',count:3},{label:'C++14 (GCC 9)',count:2}]),[{label:'C++14 (GCC 9)',count:5}]);
  assert.equal(difficultyLabel('luogu',3),'普及');
  assert.equal(difficultyLabel('luogu',5),'提高');
  assert.equal(difficultyLabel('codeforces',1200),'Rating 1200');
  assert.equal(difficultyLabel('leetcode',null),'未提供难度');
});
test('heatmap uses one rolling year or a full calendar year, including leap day', () => {
  assert.deepEqual(heatmapDates('recent',new Date(2026,8,24)),{start:'2025-09-25',end:'2026-09-24'});
  assert.deepEqual(heatmapDates('2024',new Date(2026,8,24)),{start:'2024-01-01',end:'2024-12-31'});
  const range=heatmapDates('2024');
  assert.equal((Date.parse(range.end)-Date.parse(range.start))/86400000+1,366);
});
test('daily analytics distinguish repeat AC, first AC, local midnight, gaps and contest IDs', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), me = repo.createUser('Me', true), account = repo.addAccount(me,'codeforces','me');
    const rows = [
      ['1','1:A','AC','2026-09-20T15:59:59Z'],
      ['2','1:A','AC','2026-09-20T16:00:00Z'],
      ['3','1:A','AC','2026-09-20T17:00:00Z'],
      ['4','1:B','WA','2026-09-20T18:00:00Z'],
      ['5','1:B','AC','2026-09-21T16:00:00Z'],
      ['6','1:C','AC','2026-09-23T16:00:00Z'],
    ];
    repo.saveSubmissions(account, rows.map(([id,problem,status,date]) => submission('codeforces',{ submission_id:id,problem_id:problem,status:status as 'AC'|'WA',submitted_at:time(date), difficulty:1200,tags:['math','math'],language:'C++' })));
    const luogu = repo.addAccount(me,'luogu','123');
    repo.saveSubmissions(luogu,[submission('luogu',{submission_id:'7',problem_id:'T123',status:'AC',submitted_at:time('2026-09-20T18:00:00Z')})]);
    const other = repo.createUser('Unfollowed',false), otherAccount = repo.addAccount(other,'codeforces','other');
    repo.saveSubmissions(otherAccount,[submission('codeforces',{submission_id:'8',problem_id:'9:A',status:'AC',submitted_at:time('2026-09-20T18:00:00Z')})]);
    const result = getAnalytics(db,{...f,since:time('2026-09-20T16:00:00Z'),until:time('2026-09-24T15:59:59Z')});
    assert.deepEqual(result.days[0],{date:'2026-09-21',submissions:4,ac:3,solved:1,fresh:0});
    assert.equal(result.summary.fresh,2);
    assert.equal(result.summary.solved,3);
    assert.equal(result.summary.longest,2);
    assert.equal(result.summary.current,1);
    assert.deepEqual(result.tags,[{label:'math',count:3}]);
    assert.equal(result.summary.submissions,6);
    assert.equal(result.hours.reduce((n,r)=>n+r.count,0),6);
    assert.equal(result.difficulties.length,1);
    assert.equal(getAnalytics(db,{...f,until:time('2026-09-26T15:59:59Z')}).summary.current,0);
    db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(account);
    assert.equal(getAnalytics(db,f).summary.solved,0);
  } finally { db.close(); }
});
test('empty analytics and platform filtering stay well-defined', () => {
  const db = openDatabase(':memory:');
  try {
    const result = getAnalytics(db,{...f,platforms:['codeforces']},time('2026-09-24T00:00:00Z'));
    assert.equal(result.start,'2026-09-24');
    assert.equal(result.end,'2026-09-24');
    assert.equal(result.summary.acRate,0);
    assert.equal(result.summary.longest,0);
    assert.deepEqual(result.days,[]);
  } finally { db.close(); }
});
test('calendar periods include entire local dates, leap day and Monday-based weeks', () => {
  const local = (y:number,m:number,d:number) => new Date(y,m-1,d).getTime()/1000;
  assert.deepEqual(periodBounds('month','2024-02-12'),{since:local(2024,2,1),until:local(2024,3,1)-1});
  assert.deepEqual(periodBounds('week','2026-09-27'),{since:local(2026,9,21),until:local(2026,9,28)-1});
  assert.deepEqual(periodBounds('year','2024-07-01'),{since:local(2024,1,1),until:local(2025,1,1)-1});
  assert.deepEqual(periodBounds('custom','2026-09-01','2026-09-24'),{since:local(2026,9,1),until:local(2026,9,25)-1});
  assert.deepEqual(periodBounds('all',''),{});
  assert.throws(()=>periodBounds('custom','2026-09-24','2026-09-01'));
  assert.throws(()=>periodBounds('day','2026-02-30'));
});
