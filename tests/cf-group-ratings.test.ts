import test from 'node:test';
import assert from 'node:assert/strict';
import {matchGroupTitle,refreshGroupRatings} from '../src/fetchers/cf-group-ratings.ts';
import {openDatabase,Repository} from '../src/db/database.ts';
import {submission} from '../src/fetchers/common.ts';
test('unique full title uses official rating; ambiguity and missing ratings never guess',()=>{
 const p={contestId:1,index:'A',name:'Title',rating:900};assert.equal(matchGroupTitle('Title',[p]).rating,900);
 assert.equal(matchGroupTitle('title',[p]).method,'not_found');
 assert.equal(matchGroupTitle('Title',[p,{...p,contestId:2,rating:undefined}]).method,'ambiguous');
 assert.equal(matchGroupTitle('Title',[{...p,rating:undefined}]).method,'unrated');
 assert.equal(matchGroupTitle('Arpa’s test',[{...p,name:"Arpa's test"}]).rating,900);
});
test('only group records are updated and inferred provenance is revoked when a duplicate appears',async()=>{
 const db=openDatabase(':memory:');try{const repo=new Repository(db),u=repo.createUser('Me',true),a=repo.addAccount(u,'codeforces','Tester');
 repo.saveSubmissions(a,[submission('codeforces',{submission_id:'1',problem_id:'700001:A',problem_title:'Title',problem_url:'https://codeforces.com/group/abc/contest/700001/problem/A',status:'AC',submitted_at:1}),submission('codeforces',{submission_id:'2',problem_id:'2:A',problem_title:'Title',status:'AC',submitted_at:2})]);
 const catalog=[{contestId:1,index:'A',name:'Title',rating:900}];repo.set('cf:group-source-catalog:v1',catalog,1000);
 await refreshGroupRatings(db,a);assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='1'").get()!.difficulty,900);assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='2'").get()!.difficulty,null);
 assert.equal(db.prepare('SELECT source_problem_id FROM cf_group_rating_sources').get()!.source_problem_id,'1:A');
 repo.set('cf:group-source-catalog:v1',[...catalog,{...catalog[0],contestId:3}],1000);await refreshGroupRatings(db,a);
 assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='1'").get()!.difficulty,null);assert.equal(db.prepare('SELECT method FROM cf_group_rating_sources').get()!.method,'ambiguous');
 }finally{db.close();}
});
