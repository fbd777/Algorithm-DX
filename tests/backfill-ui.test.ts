import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackfillController } from '../public/backfill.js';

test('backfill targets one account and resumes without restarting history',async()=>{
  const calls:any[]=[],notices:any[]=[];let refreshed=0;
  const job={id:12,accountId:7,mode:'backfill',running:false,results:[{accountId:7,status:'success',fetched:100,inserted:60}]};
  const c=createBackfillController({request:async(path:any,options:any)=>{calls.push({path,options});return {status:200,body:{job}};},notify:(s:any)=>notices.push(s),refresh:async()=>{refreshed++;}});
  await c.start({id:7,handle:'friend'});
  assert.deepEqual(JSON.parse(calls[0].options.body),{accountId:7,mode:'backfill',force:false});
  assert.equal(refreshed,1);assert.equal(notices.at(-1).busy,false);assert.match(notices.at(-1).text,/新增 60 条/);
});
test('busy sync is not reported as a successful backfill',async()=>{
  const notices:any[]=[];let refreshed=0;
  const c=createBackfillController({request:async()=>({status:409,body:{job:{id:1,running:true}}}),notify:(s:any)=>notices.push(s),refresh:async()=>{refreshed++;}});
  await c.start({id:7,handle:'friend'});assert.equal(refreshed,0);assert.equal(notices.at(-1).busy,false);assert.match(notices.at(-1).text,/尚未启动/);
});
test('failed or skipped backfill never claims completion',async()=>{
  for(const status of ['failed','skipped']) {
    const notices:any[]=[];let refreshed=0;
    const job={id:1,accountId:7,mode:'backfill',running:false,results:[{accountId:7,status,message:'Cookie 已过期'}]};
    const c=createBackfillController({request:async()=>({status:200,body:{job}}),notify:(s:any)=>notices.push(s),refresh:async()=>{refreshed++;}});
    await c.start({id:7,handle:'friend'});assert.equal(refreshed,0);assert.match(notices.at(-1).text,/Cookie 已过期/);assert.doesNotMatch(notices.at(-1).text,/本轮回补完成/);
  }
});
