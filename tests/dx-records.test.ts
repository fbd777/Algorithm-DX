import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryRecords,recordsCsv} from '../public/dx-records.js';
const records=[
  {problemId:'1:A',problemTitle:'Alpha',problemRating:1000,recordedSeconds:600,releasedAt:1735689600,solvedAt:100,state:'onBoard',score:{rating:20,achievementShown:97,rank:'S'}},
  {problemId:'2:B',problemTitle:'Beta',problemRating:1600,recordedSeconds:1200,releasedAt:1770000000,solvedAt:200,state:'belowCutoff',score:{rating:18,achievementShown:90,rank:'AA'}},
  {problemId:'3:C',problemTitle:'Pending',problemRating:null,recordedSeconds:100,releasedAt:null,solvedAt:300,state:'waitingRating',score:null},
];
test('score library combines ranges, search, rank, state and year without treating unknown values as zero',()=>{
  assert.deepEqual(queryRecords(records,{difficultyMin:900,difficultyMax:1200,achievementMin:97,secondsMax:600,query:'ALP',rank:'S',state:'onBoard'}).map(r=>r.problemId),['1:A']);
  assert.equal(queryRecords(records,{achievementMax:0}).length,0);
  assert.equal(queryRecords(records,{difficultyMax:2000}).length,2);
  assert.equal(queryRecords(records,{state:'waitingRating'}).length,1);
  assert.deepEqual(queryRecords(records,{rank:'other'}).map(r=>r.problemId),['2:B']);
  assert.deepEqual(queryRecords(records,{partition:'new',year:2026}).map(r=>r.problemId),['2:B']);
  assert.equal(queryRecords(records,{partition:'old',year:2026}).length,2);
  assert.throws(()=>queryRecords(records,{secondsMin:1200,secondsMax:600}),/下限/);
});
test('all sort directions are deterministic, unknown scores last, source array stays untouched',()=>{
  for(const [key,expected] of [['rating','2:B'],['achievement','2:B'],['difficulty','1:A'],['seconds','3:C'],['date','1:A'],['problem','1:A']]) {
    assert.equal(queryRecords(records,{sort:key+'_asc'})[0].problemId,expected);
  }
  assert.equal(queryRecords(records,{sort:'difficulty_desc'})[0].problemId,'2:B');
  assert.equal(queryRecords(records,{sort:'rating_asc'}).at(-1)?.problemId,'3:C');
  assert.deepEqual(records.map(r=>r.problemId),['1:A','2:B','3:C']);
});
test('CSV escapes quotes, preserves unicode and neutralizes spreadsheet formulas',()=>{
  const csv=recordsCsv([{...records[0],problemTitle:'=HYPERLINK("example")'}]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=HYPERLINK(""example"")"'));
});
