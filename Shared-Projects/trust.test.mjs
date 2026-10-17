import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TrustPolicy,ensureTrustedRoots} from './trust.mjs';
import {stateDirectory} from './catalog.mjs';
import {findMessageBusImport,configRequest} from './desktop.mjs';

const root='C:\\work\\upwork\\code\\proposals\\daily\\2026\\10\\16\\1 - a.b';
const configFile='C:\\Users\\test\\.codex\\config.toml';
const policy={policy:'upwork-daily',roots:[root],configFile};
function connection({projects={},userProjects={},status='ok',apply=true,file=configFile}={}){
  const calls=[],config={projects:structuredClone(projects)};
  const request=async(method,params)=>{
    calls.push({method,params:structuredClone(params)});
    if(method==='config/read')return structuredClone({config,layers:[{name:{type:'user',file},version:'revision-one',config:{projects:userProjects}}]});
    assert.equal(method,'config/batchWrite');
    if(apply)config.projects[root]={trust_level:'trusted'};
    return {status};
  };
  return {request,calls,config};
}
test('exact trust uses atomic versioned config API and verifies effective result',async()=>{
  const c=connection({projects:{'C:\\work\\upwork\\code':{trust_level:'trusted'}}});
  const result=await ensureTrustedRoots(c.request,policy);
  assert.equal(result.status,'verified');assert.equal(result.written,true);
  assert.deepEqual(c.calls.map(x=>x.method),['config/read','config/batchWrite','config/read']);
  assert.deepEqual(c.calls[1].params,{edits:[{keyPath:'projects.'+JSON.stringify(root)+'.trust_level',value:'trusted',mergeStrategy:'replace'}],filePath:configFile,expectedVersion:'revision-one',reloadUserConfig:true});
});
test('an already trusted exact key is read without rewriting config',async()=>{
  const c=connection({projects:{[root]:{trust_level:'trusted'}}});
  const result=await ensureTrustedRoots(c.request,policy);
  assert.equal(result.written,false);assert.equal(c.calls.length,2);
});
test('effective or overridden explicit untrusted aliases stop before writes',async()=>{
  for(const input of [{projects:{[root.toLowerCase()]:{trust_level:'untrusted'}}},{projects:{[root]:{trust_level:'trusted'}},userProjects:{[root.toLowerCase()]:{trust_level:'untrusted'}}}]){
    const c=connection(input);await assert.rejects(ensureTrustedRoots(c.request,policy),/^Error: UNTRUSTED_PROJECT:/);
    assert.deepEqual(c.calls.map(x=>x.method),['config/read']);
  }
});
test('overridden and unverifiable writes do not grant registration',async()=>{
  for(const [input,pattern]of [[{status:'overridden'},/TRUST_OVERRIDDEN/],[{apply:false},/TRUST_UNVERIFIED/],[{file:'C:\\other\\config.toml'},/TRUST_PROFILE_MISMATCH/]]){
    const c=connection(input);await assert.rejects(ensureTrustedRoots(c.request,policy),pattern);
  }
});
test('a lost config acknowledgement is safely recovered by the next exact read',async()=>{
  const c=connection();let fail=true;
  const request=async(method,params)=>{const result=await c.request(method,params);if(method==='config/batchWrite'&&fail){fail=false;throw Error('transport disconnected after write');}return result;};
  await assert.rejects(ensureTrustedRoots(request,policy),/disconnected/);
  assert.equal((await ensureTrustedRoots(request,policy)).written,false);
  assert.equal(c.calls.filter(x=>x.method==='config/batchWrite').length,1);
});
test('native message discovery follows renamed imports and rejects ambiguity',()=>{
  const source='import{busExport as bus}from`./shared.js`;bus.subscribe(`shared-object-updated`,x=>x);bus.dispatchMessage(x,y)';
  assert.deepEqual(findMessageBusImport(source),{name:'busExport',url:'./shared.js'});
  assert.throws(()=>findMessageBusImport(source+';other.subscribe(`shared-object-updated`,x=>x)'),/ambiguous/);
});
test('config requests correlate the exact local response and remove their subscription',async()=>{
  let handler,removed=0;
  const bus={subscribe(type,fn){assert.equal(type,'mcp-response');handler=fn;return()=>removed++;},dispatchMessage(type,message){
    assert.equal(type,'mcp-request');
    handler({hostId:'C2',message:{id:message.request.id,result:{wrong:true}}});
    handler({hostId:'local',message:{id:'other',result:{wrong:true}}});
    handler({hostId:'local',message:{id:message.request.id,result:{config:{projects:{}}}}});
  }};
  assert.deepEqual(await configRequest(bus,'config/read',{}),{config:{projects:{}}});assert.equal(removed,1);
  assert.throws(()=>configRequest(bus,'turn/start',{}),/Unsupported/);
});
test('policy scope comes from runtime and rejects traversal, non-directories and links escaping daily',async t=>{
  const testRoot=path.join(stateDirectory,'tests');await fs.mkdir(testRoot,{recursive:true});
  const dir=await fs.mkdtemp(path.join(testRoot,'trust-'));
  t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(testRoot)+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const daily=path.join(dir,'daily'),inside=path.join(daily,'2026','10','16','one'),outside=path.join(dir,'outside');
  await fs.mkdir(inside,{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(daily,'file'),'x');
  const runtime=path.join(dir,'runtime.json'),policyFile=path.join(dir,'policy.json');
  await fs.writeFile(runtime,JSON.stringify({workspace_root:dir,daily_root:'daily'}));await fs.writeFile(policyFile,JSON.stringify({upworkRuntime:runtime}));
  const service=new TrustPolicy(policyFile),spec={trustPolicy:'upwork-daily',rootPaths:[inside]};
  assert.deepEqual(await service.prepare(spec),spec);
  for(const root of [daily,outside,path.join(daily,'..','outside'),path.join(daily,'file')])await assert.rejects(service.prepare({...spec,rootPaths:[root]}),/TRUST_POLICY/);
  const link=path.join(daily,'escape');await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(service.prepare({...spec,rootPaths:[link]}),/TRUST_POLICY/);
  await assert.rejects(service.prepare({...spec,trustPolicy:'arbitrary'}),/TRUST_POLICY/);
  assert.deepEqual(await service.prepare({rootPaths:[outside]}),{rootPaths:[outside]});
});
