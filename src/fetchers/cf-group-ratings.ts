import type {DatabaseSync} from 'node:sqlite';
import {Repository} from '../db/database.ts';
import {HttpClient} from './http.ts';
const normalize=(s:string)=>s.normalize('NFKC').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim();
export function matchGroupTitle(title:string,catalog:any[]){
 const matches=new Map<string,any>();
 for(const p of catalog)if(typeof p?.name==='string'&&normalize(p.name)===normalize(title)&&Number.isSafeInteger(p.contestId)&&p.contestId>0&&typeof p.index==='string'&&/^[A-Za-z0-9]+$/.test(p.index))matches.set(p.contestId+':'+p.index,p);
 if(matches.size!==1)return {method:matches.size?'ambiguous':'not_found',sourceId:null,url:null,rating:null};
 const p=[...matches.values()][0],rating=Number.isSafeInteger(p.rating)&&p.rating>0?p.rating:null;
 return {method:rating===null?'unrated':'unique_title',sourceId:p.contestId+':'+p.index,url:'https://codeforces.com/problemset/problem/'+p.contestId+'/'+p.index,rating};
}
export async function refreshGroupRatings(db:DatabaseSync,accountId:number,http=new HttpClient(db)){
 const rows=db.prepare("SELECT DISTINCT problem_id,problem_title FROM submissions WHERE account_id=? AND platform='codeforces' AND problem_url LIKE 'https://codeforces.com/group/%'").all(accountId) as {problem_id:string;problem_title:string}[];
 if(!rows.length)return '';
 const repo=new Repository(db);let catalog=repo.get<any[]>('cf:group-source-catalog:v1');
 if(!catalog){const body=await http.json('https://codeforces.com/api/problemset.problems');if(body?.status!=='OK'||!Array.isArray(body.result?.problems))throw Error('CF 原题清单暂不可用');catalog=body.result.problems;repo.set('cf:group-source-catalog:v1',catalog,21600);}
 let resolved=0;db.exec('SAVEPOINT group_ratings');
 try{for(const row of rows){
 const match=matchGroupTitle(row.problem_title,catalog);const old=db.prepare('SELECT rating FROM cf_group_rating_sources WHERE problem_id=?').get(row.problem_id);
 if(old?.rating!=null)db.prepare("UPDATE submissions SET difficulty=NULL WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%' AND difficulty=?").run(row.problem_id,old.rating);
 db.prepare('INSERT INTO cf_group_rating_sources(problem_id,source_problem_id,source_url,rating,method) VALUES(?,?,?,?,?) ON CONFLICT(problem_id) DO UPDATE SET source_problem_id=excluded.source_problem_id,source_url=excluded.source_url,rating=excluded.rating,method=excluded.method,updated_at=unixepoch()').run(row.problem_id,match.sourceId,match.url,match.rating,match.method);
 if(match.rating!==null){db.prepare("UPDATE submissions SET difficulty=? WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%' AND difficulty IS NULL").run(match.rating,row.problem_id);resolved++;}
 }db.exec('RELEASE group_ratings');}catch(e){db.exec('ROLLBACK TO group_ratings; RELEASE group_ratings');throw e;}
 return 'Group 原题难度：'+resolved+' 题按官方题库唯一同名匹配，'+(rows.length-resolved)+' 题待确认或无评级';
}
