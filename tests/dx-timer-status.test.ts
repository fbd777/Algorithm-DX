import test from 'node:test';
import assert from 'node:assert/strict';
import { timerSyncNotice } from '../public/dx-timer-status.js';

const timer = { account_id: 1, started_at: 100 };
test('a disconnected extension explains how to recover the timed submission', () => {
  const notice = timerSyncNotice({runs:[{account_id:1,started_at:110,status:'failed',error_code:'CF_EXTENSION_REQUIRED'}]}, timer);
  assert.match(notice, /Edge 扩展未连接/);
  assert.match(notice, /实际 AC 提交时间/);
});
test('old failures and failures belonging to another account do not blame this timer', () => {
  const notice = timerSyncNotice({runs:[{account_id:2,started_at:110,status:'failed',message:'other account'},
    {account_id:1,started_at:90,status:'failed',message:'old failure'}]}, timer);
  assert.match(notice, /等待/);
  assert.doesNotMatch(notice, /失败/);
});
test('an active retry supersedes its previous failure', () => {
  assert.match(timerSyncNotice({job:{running:true,accountId:1},runs:[{account_id:1,started_at:110,status:'failed'}]}, timer), /正在检查/);
});
test('sync errors remain visible while ordinary completed checks explain the AC requirement', () => {
  assert.match(timerSyncNotice({job:{accountId:1,startedAt:110,error:'网络不可用'}}, timer), /网络不可用/);
  assert.match(timerSyncNotice({runs:[{account_id:1,started_at:110,status:'success'}]}, timer), /尚未通过/);
});
