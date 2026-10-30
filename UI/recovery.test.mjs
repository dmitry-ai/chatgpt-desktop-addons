import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TurnLog,C1Recovery,UpdateRecovery,UpdateIntentLog} from './recovery.mjs';

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

test('closing C1 window to tray closes the hidden background process',async()=>{
  const closed=[];
  let current={...processInfo,HasVisibleWindow:true};
  const recovery=new C1Recovery({probe:async()=>current,closeHidden:async p=>{closed.push(p.Pid);},activity:async()=>({active:0,quiet:true}),recover:async()=>{}});
  await recovery.tick(since);
  assert.deepEqual(closed,[]);
  current={...processInfo,HasVisibleWindow:false};
  await recovery.tick(since+3000);
  assert.deepEqual(closed,[123]);
  assert.equal(recovery.status.state,'closed');
});

const oldPackage='OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0';
const newPackage='OpenAI.Codex_2.0.0.0_x64__2p2nqsd0c76g0';
function updateFixture(){
  const origin={...processInfo,Package:oldPackage,HasDebugPort:true};
  const calls=[],activityStarts=[];let current=origin,marker=null,prepared={Ready:true,Newer:true},active=0;
  const update=new UpdateRecovery({probe:async()=>current,intent:async()=>marker,
    prepare:async value=>{calls.push(['prepare',value.Pid]);return prepared;},
    launch:async()=>{calls.push(['launch']);return 124;},
    recover:async value=>{calls.push(['recover',value.Pid]);},
    activity:async started=>{activityStarts.push(started);return {active,quiet:true};}});
  return {origin,update,calls,activityStarts,setCurrent:p=>current=p,setMarker:m=>marker=m,setPrepared:p=>prepared=p,setActive:a=>active=a};
}
test('ordinary quit, stale update and a new manual session never cause an automatic relaunch',async()=>{
  const f=updateFixture();await f.update.tick(since,true);
  f.setCurrent(null);await f.update.tick(since+3000);assert.deepEqual(f.calls,[]);
  const g=updateFixture();g.setCurrent({...g.origin,HasDebugPort:false});await g.update.tick(since+3000,false);
  assert.deepEqual(g.calls,[]);assert.equal(g.update.status.state,'watching');
});
test('failed in-app restart is completed outside the app, then waits for actual Folders/UI verification',async()=>{
  const f=updateFixture();await f.update.tick(since,true);
  f.setMarker({at:since+1000});f.setCurrent(null);await f.update.tick(since+3000);
  assert.deepEqual(f.calls,[['prepare',123],['launch']]);
  assert.equal(f.update.status.state,'waiting-for-ui');
  f.setCurrent({...f.origin,Pid:124,StartTicks:'new',Package:newPackage});
  await f.update.tick(since+6000,false);assert.equal(f.update.status.state,'waiting-for-ui');
  await f.update.tick(since+9000,true);assert.equal(f.update.status.state,'verified');
  assert.equal(f.update.pending,null);
  await f.update.tick(since+12000,true);assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
});
test('registration waits for another profile and never launches the previous package',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});f.setCurrent(null);
  f.setPrepared({Ready:false,PendingPackage:newPackage});await f.update.tick(since+3000);
  assert.equal(f.update.status.state,'waiting-for-other-apps');assert.equal(f.calls.length,1);
  f.setPrepared({Ready:true,Newer:false});await f.update.tick(since+6000);
  assert.equal(f.update.status.state,'error');assert.equal(f.calls.filter(c=>c[0]==='launch').length,0);
});
test('only an idle newborn instance after an observed update may recover a lost launch flag',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});
  const replacement={...f.origin,Pid:124,StartTicks:'new',StartedAt:new Date(since+2000).toISOString(),Package:newPackage,HasDebugPort:false};
  f.setCurrent(replacement);f.setActive(1);await f.update.tick(since+4000);
  assert.equal(f.calls.length,0);assert.equal(f.update.status.state,'waiting-for-turns');
  f.setActive(0);await f.update.tick(since+7000);assert.deepEqual(f.calls,[['recover',124]]);
  assert.ok(f.activityStarts.every(started=>started===f.origin.StartedAt),'Answers resumed from the original app must be included');
  await f.update.tick(since+10000);assert.equal(f.update.status.state,'error');assert.equal(f.calls.length,1);
});
test('a post-update C1 already in use is left open',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});
  f.setCurrent({...f.origin,Pid:124,StartTicks:'new',StartedAt:new Date(since+2000).toISOString(),Package:newPackage,HasDebugPort:false});
  await f.update.tick(since+25000);assert.equal(f.update.status.state,'error');assert.deepEqual(f.calls,[]);
});
test('helper stop during registration cannot start an application afterwards',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});f.setCurrent(null);
  f.update.prepare=async()=>{f.update.stopped=true;return {Ready:true,Newer:true};};
  await f.update.tick(since+3000);assert.deepEqual(f.calls,[]);
});
test('an updated process that exits is not relaunched in a loop',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});f.setCurrent(null);
  await f.update.tick(since+3000);await f.update.tick(since+6000);await f.update.tick(since+9000);
  assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);assert.equal(f.update.status.state,'error');
});
test('a failed attempt stays blocked until a verified session, then a later update can be handled',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});f.setCurrent(null);
  f.setPrepared({Ready:true,Newer:false});await f.update.tick(since+3000);assert.equal(f.update.failed,true);
  await f.update.tick(since+6000);assert.equal(f.calls.length,1);
  const next={...f.origin,Pid:124,StartTicks:'new',Package:newPackage};f.setCurrent(next);
  await f.update.tick(since+9000,true);assert.equal(f.update.failed,false);
  f.setMarker({at:since+10000});f.setCurrent(null);f.setPrepared({Ready:true,Newer:true});
  await f.update.tick(since+12000);assert.deepEqual(f.calls.at(-1),['launch']);
});
test('newborn unchanged-version relaunch after failed Store registration is recovered into the staged update',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});
  const reopenedOld={...f.origin,Pid:124,StartTicks:'reopened',StartedAt:new Date(since+2000).toISOString(),Package:oldPackage,HasDebugPort:false};
  f.setCurrent(reopenedOld);await f.update.tick(since+4000,false);
  assert.deepEqual(f.calls,[['recover',124]]);assert.equal(f.update.status.state,'waiting-for-ui');
  f.setCurrent({...f.origin,Pid:125,StartTicks:'updated',StartedAt:new Date(since+5000).toISOString(),Package:newPackage,HasDebugPort:true});
  await f.update.tick(since+7000,true);assert.equal(f.update.status.state,'verified');assert.equal(f.update.pending,null);
});
test('a fresh update intent from a new process unblocks a previously failed update even without debug port',async()=>{
  const f=updateFixture();await f.update.tick(since,true);f.setMarker({at:since+1000});f.setCurrent(null);
  f.setPrepared({Ready:true,Newer:false});await f.update.tick(since+3000);assert.equal(f.update.failed,true);
  const unported={...f.origin,Pid:125,StartTicks:'unported',StartedAt:new Date(since+4000).toISOString(),Package:oldPackage,HasDebugPort:false};
  f.setCurrent(unported);f.setMarker({at:since+5000,pid:125,startTicks:'unported'});
  await f.update.tick(since+6000,false);assert.equal(f.update.failed,false);assert.equal(f.update.status.state,'waiting-for-updater-exit');
  f.setCurrent(null);f.setPrepared({Ready:true,Newer:true});
  await f.update.tick(since+9000,false);assert.deepEqual(f.calls.at(-1),['launch']);
});
test('update intent accepts only a complete native marker for the observed process lifetime',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'CodexUIIntentTest-'));
  try{
    const directory=path.join(root,'2026','10','16');await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,'codex-desktop-00000000-0000-0000-0000-000000000000-123-t0-i1-170000-0.log');
    const marker=new Date(since+1000).toISOString()+' info update_resume_state_saved threadCount=0';
    await fs.writeFile(file,'посторонняя строка\n'+marker);
    const log=new UpdateIntentLog(root);assert.equal(await log.read(processInfo,since+3000),null);
    await fs.appendFile(file,'\n');assert.equal((await log.read(processInfo,since+4000)).at,since+1000);
    assert.equal(await log.read({...processInfo,StartTicks:'reused',StartedAt:new Date(since+2000).toISOString()},since+5000),null);
    assert.equal(await log.read(processInfo,since+130000),null);
  }finally{
    const resolved=path.resolve(root);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('CodexUIIntentTest-'))throw Error('Unexpected test cleanup path');
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
