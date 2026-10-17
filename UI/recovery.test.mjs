import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnLog,C1Recovery} from './recovery.mjs';

const since=Date.parse('2026-10-16T17:00:00Z');
const row=(type,id,time=since+1000)=>JSON.stringify({timestamp:new Date(time).toISOString(),type:'event_msg',payload:{type,turn_id:id}})+'\n';
const processInfo={Pid:123,StartTicks:'456',StartedAt:new Date(since).toISOString(),HasDebugPort:false,RestartRegistered:true};
function fixture({process=processInfo,active=0,quiet=true}={}){
  const calls=[];
  const recovery=new C1Recovery({allowAutomaticRestart:true,probe:async()=>process,activity:async()=>({active,quiet}),recover:async p=>{calls.push(p);return 124;}});
  return {recovery,calls};
}

test('active answer survives arbitrary UTF-8 chunks, completion clears only its own turn',()=>{
  const log=new TurnLog(since);
  const bytes=Buffer.from(row('task_started','first')+row('task_started','второй')+row('task_complete','first'));
  for(let i=0;i<bytes.length;i+=7)log.push(bytes.subarray(i,i+7));
  assert.deepEqual([...log.active],['второй']);assert.equal(log.carry,'');assert.equal(log.error,null);
  log.push(Buffer.from(row('turn_aborted','второй')));assert.equal(log.active.size,0);
});
test('an interrupted old app session cannot block the updated process forever',()=>{
  const log=new TurnLog(since);log.push(Buffer.from(row('task_started','crashed',since-1000)+row('task_started','current')));
  assert.deepEqual([...log.active],['current']);
});
test('partial and malformed lifecycle records never appear safely idle',()=>{
  const log=new TurnLog(since),record=row('task_started','current');
  log.push(Buffer.from(record.slice(0,-5)));assert.notEqual(log.carry,'');
  log.push(Buffer.from(record.slice(-5)));assert.equal(log.active.size,1);
  log.push(Buffer.from('{invalid}\n'));assert.ok(log.error);
});
test('a normal connected launch or an already-present port does not restart C1',async()=>{
  const f=fixture({process:{...processInfo,HasDebugPort:true}});await f.recovery.tick();
  assert.equal(f.calls.length,0);assert.equal(f.recovery.status.state,'waiting-for-ui');
  f.recovery.connected();assert.equal(f.recovery.status.state,'connected');
});
test('closed C1, active answers and the final-message quiet period do not trigger recovery',async()=>{
  for(const options of [{process:null},{active:1},{quiet:false}]){
    const f=fixture(options);await f.recovery.tick();assert.equal(f.calls.length,0);
  }
});
test('activity that starts during the recovery decision cancels the restart',async()=>{
  let reads=0,restarts=0;
  const recovery=new C1Recovery({allowAutomaticRestart:true,probe:async()=>processInfo,activity:async()=>({active:reads++?1:0,quiet:true}),recover:async()=>{restarts++;}});
  await recovery.tick();assert.equal(restarts,0);
});
test('stopping the UI helper cancels an inspected but not yet requested restart',async()=>{
  let restarts=0;
  const recovery=new C1Recovery({allowAutomaticRestart:true,probe:async()=>processInfo,activity:async()=>{
    recovery.stopped=true;return {active:0,quiet:true};
  },recover:async()=>{restarts++;}});
  await recovery.tick();assert.equal(restarts,0);
});
test('missing flag recovers only the inspected process once, then waits for actual UI verification',async()=>{
  const f=fixture();await f.recovery.tick(since);await f.recovery.tick(since+100000);
  assert.deepEqual(f.calls,[processInfo]);assert.equal(f.recovery.status.state,'waiting-for-verification');
  f.recovery.connected();assert.equal(f.recovery.blocked,false);
});
test('unknown lifecycle state, native refusal or missing restart registration stop without a retry loop',async()=>{
  for(const failure of ['activity','recover','registration']){
    let attempts=0;
    const recovery=new C1Recovery({allowAutomaticRestart:true,probe:async()=>({...processInfo,RestartRegistered:failure!=='registration'}),
      activity:async()=>{if(failure==='activity')throw Error('Unreadable lifecycle');return {active:0,quiet:true};},
      recover:async()=>{attempts++;throw Error('App refused shutdown');}});
    await recovery.tick(since);await recovery.tick(since+100000);
    assert.equal(attempts,failure==='recover'?1:0);assert.equal(recovery.status.state,'error');
  }
});

test('background recovery leaves a running C1 without the launch flag for manual relaunch',async()=>{
  let calls=0;
  const recovery=new C1Recovery({probe:async()=>processInfo,activity:async()=>{throw Error('Must not inspect sessions');},recover:async()=>calls++});
  await recovery.tick(since);await recovery.tick(since+100000);
  assert.equal(calls,0);assert.equal(recovery.status.state,'waiting-for-manual-launch');
});
