import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { getCircle } from '../src/server/circle.ts';
import { handleApi, type ApiContext } from '../src/server/api.ts';
import type { Filters } from '../src/server/queries.ts';
const filters: Filters = { platforms:[],userId:null,scope:'all',status:'all',q:null,since:null,until:null,tzOffsetMinutes:480 };
function fixture() {
  const db=openDatabase(':memory:'), repo=new Repository(db);
  const me=repo.createUser('我',true), friend=repo.createUser('小林',false), hidden=repo.createUser('未关注',false), empty=repo.createUser('新题友',false);
  db.prepare('UPDATE users SET is_followed=0 WHERE id=?').run(hidden);
  const a=repo.addAccount(friend,'codeforces','friend'), old=repo.addAccount(friend,'codeforces','old');
  const add=(id:number,platform:string,problem:string,status:'AC'|'WA',time:number,n:string)=>repo.saveSubmissions(id,[submission(platform,{submission_id:n,problem_id:problem,problem_title:problem,status,submitted_at:time})]);
  for(let i=0;i<65;i++) add(a,'codeforces',`1:${i%3}`,i%2?'AC':'WA',1000,'s'+i);
  add(repo.addAccount(me,'codeforces','me'),'codeforces','self','AC',2000,'self');
  add(repo.addAccount(hidden,'codeforces','hidden'),'codeforces','hidden','AC',2000,'hidden');
  add(old,'codeforces','old','AC',3000,'old'); db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(old);
  return {db,repo,friend,hidden,empty,add};
}
test('circle isolates followed people and paginates tied timestamps without losing attempts',()=>{
 const {db,friend,empty}=fixture();try {
  db.exec('PRAGMA query_only=ON');
  const first=getCircle(db,filters,null); assert.equal(first.items.length,30); assert.equal(first.people.length,2);
  assert.equal(first.people.find(p=>p.id===friend)?.submissions,65); assert.equal(first.people.find(p=>p.id===empty)?.submissions,0);
  const second=getCircle(db,filters,first.next),third=getCircle(db,filters,second.next);
  const all=[...first.items,...second.items,...third.items]; assert.equal(all.length,65); assert.equal(new Set(all.map(r=>r.id)).size,65); assert.equal(third.next,null);
  assert.ok(all.every(r=>r.user_id===friend)); assert.ok(all.some(r=>r.status==='WA'));
 }finally{db.close();}
});
test('circle filters people, status, dates, literal search, and archived accounts explicitly',()=>{
 const {db,repo,friend,hidden,add}=fixture();try {
  assert.equal(getCircle(db,{...filters,userId:hidden},null,true).items.length,0);
  assert.equal(getCircle(db,{...filters,since:1001},null).items.length,0);
  assert.ok(getCircle(db,{...filters,status:'unac'},null).items.every(r=>r.status!=='AC'));
  assert.equal(getCircle(db,{...filters,platforms:['luogu']},null).items.length,0);
  assert.equal(getCircle(db,{...filters,q:'%'},null).items.length,0);
  assert.equal(getCircle(db,filters,null,true).items[0].is_archived,0);
  assert.equal(getCircle(db,{...filters,userId:friend},null,true).items[0].problem_id,'old');
  const luogu=repo.addAccount(friend,'luogu','123'); add(luogu,'luogu','T123','AC',4000,'temp');
  assert.equal(getCircle(db,filters,null).people.find(p=>p.id===friend)?.solved,3);
  db.prepare('UPDATE users SET is_followed=0 WHERE id=?').run(friend);
  assert.equal(getCircle(db,{...filters,userId:friend},null,true).items.length,0);
 }finally{db.close();}
});
test('circle API rejects malformed parameters and never opens a write connection',async()=>{
 const {db}=fixture();try {
  const ctx={db,platforms:['codeforces'],openWrite:()=>{throw Error('write attempted');}} as unknown as ApiContext;
  for(const query of ['cursor=nope','cursor=1:999999999999999999999','user=-1','status=oops','platform=oops']) {
   assert.equal((await handleApi(ctx,{method:'GET',pathname:'/api/circle',params:new URLSearchParams(query)})).status,400);
  }
  assert.equal((await handleApi(ctx,{method:'GET',pathname:'/api/circle',params:new URLSearchParams()})).status,200);
 }finally{db.close();}
});
