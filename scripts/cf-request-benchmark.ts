import { openProbe } from './probe-context.mjs';
import { openDatabase } from '../src/db/database.ts';
import { HttpClient } from '../src/fetchers/http.ts';
const { db: source, userId } = openProbe();
const account = source.prepare("SELECT handle FROM accounts WHERE user_id=? AND platform='codeforces' AND is_archived=0 ORDER BY id LIMIT 1").get(userId);
source.close();
if (!account) throw new Error('所选用户没有 Codeforces 账号，请先绑定账号。');
const db=openDatabase(':memory:');
let attempt=0;
const traced:typeof fetch=async(url,init)=>{
 const start=performance.now(),number=++attempt;
 try { const r=await fetch(url,init);console.log({attempt:number,headersMs:Math.round(performance.now()-start),status:r.status});return r; }
 catch(e:any){console.log({attempt:number,failedMs:Math.round(performance.now()-start),name:e.name,cause:e.cause?.code});throw e;}
};
const start=performance.now();
try { const body=await new HttpClient(db,traced).json('https://codeforces.com/api/user.status?'+new URLSearchParams({handle:String(account.handle),from:'1',count:'100'}));console.log({totalMs:Math.round(performance.now()-start),rows:body.result?.length}); }
finally { db.close(); }
