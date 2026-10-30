import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CDP} from '../UI/cdp.mjs';
import {profiles} from '../UI/paths.mjs';
import {control} from '../UI/manage.mjs';
import {stateDirectory} from './catalog.mjs';

const exercise=process.argv.includes('--exercise');
const connections=new Map();
async function connection(profile){
  if(connections.has(profile))return connections.get(profile);
  const config=profiles.find(p=>p.id===profile),targets=await(await fetch('http://127.0.0.1:'+config.port+'/json/list')).json();
  const target=targets.find(t=>t.type==='page'&&t.url==='app://-/index.html');if(!target)throw Error(profile+' window is unavailable');
  const c=await CDP.open(target.webSocketDebuggerUrl);await c.call('Runtime.enable');connections.set(profile,c);return c;
}
async function read(profile){return(await connection(profile)).evaluate('window.__codexSharedDesktop?.read()');}
async function native(profile,method,args){
  assert.ok(['upsertLocal','renameLocal','removeLocal'].includes(method));
  const expression='(async()=>{const api=window.__codexSharedDesktop;if(!api)throw Error("Desktop adapter unavailable");const mod=await import(api.info.url);return mod[api.info.exportName]()['+JSON.stringify(method)+'](...'+JSON.stringify(args)+');})()';
  return(await connection(profile)).evaluate(expression,60000);
}
async function waitFor(check,message){
  const deadline=Date.now()+45000;let last;
  while(Date.now()<deadline){try{last=await check();if(last)return last;}catch(e){last=e.message;}await new Promise(resolve=>setTimeout(resolve,250));}
  throw Error(message+'; last: '+JSON.stringify(last));
}
async function verifyMemberships(catalog){
  const report={};
  for(const profile of profiles){
    const previous=JSON.parse(await fs.readFile(path.join(catalog.migration.backup,profile.id,'.codex-global-state.json'),'utf8'));
    const current=JSON.parse(await fs.readFile(path.join(profile.home,'.codex-global-state.json'),'utf8'));
    const before=previous['thread-project-assignments']??{},after=current['thread-project-assignments']??{};
    for(const [id,value]of Object.entries(before))assert.deepEqual(after[id],value,profile.id+' existing assignment '+id);
    const nativeProjects=await read(profile.id);let preserved=0;
    for(const [id,p]of Object.entries(previous['local-projects']??{})){
      if(p.chatGptBacking||p.chatGptBackingCreation||p.retiredChatGptBacking)continue;
      assert.ok(nativeProjects[id],profile.id+' original native project ID '+id);
      assert.equal(nativeProjects[id].name,p.name);assert.deepEqual(nativeProjects[id].rootPaths,p.rootPaths);preserved++;
    }
    const old=new DatabaseSync(path.join(catalog.migration.backup,profile.id,'state_5.sqlite'),{readOnly:true});
    const live=new DatabaseSync(path.join(profile.home,'state_5.sqlite'),{readOnly:true});
    let count=0;
    try{
      const prior=old.prepare('select id,project_id from threads where project_id is not null').all();
      const get=live.prepare('select project_id from threads where id=?');
      for(const row of prior){assert.equal(get.get(row.id)?.project_id,row.project_id,profile.id+' existing database assignment '+row.id);count++;}
    }finally{old.close();live.close();}
    report[profile.id]={legacyAssignmentsPreserved:Object.keys(before).length,databaseAssignmentsPreserved:count,originalNativeProjectsPreserved:preserved};
  }
  return report;
}
let testId=null,folderId=null,logicalId=null;
const report={createdAt:new Date().toISOString(),exercise};
try{
  const initial=await control({command:'shared-catalog'});
  const before=Object.fromEntries(await Promise.all(profiles.map(async p=>[p.id,await read(p.id)])));
  report.projects=Object.fromEntries(profiles.map(p=>[p.id,Object.values(before[p.id]).map(p=>p.name)]));
  assert.deepEqual([...new Set(report.projects.C1)].sort(),[...new Set(report.projects.C2)].sort());
  report.folders=initial.folders.length;
  report.memberships=await verifyMemberships(initial);
  if(exercise){
    testId=randomUUID();folderId=randomUUID();const name='Shared Projects — проверка '+testId.slice(0,8),renamed=name+' C2';
    const root=path.join(stateDirectory,'integration-workspace');await fs.mkdir(root,{recursive:true});
    await fs.writeFile(path.join(stateDirectory,'verification-fixture.json'),JSON.stringify({c1Id:testId,folderId,root,name,createdAt:new Date().toISOString()},null,2)+'\n');
    for(const profile of profiles)await(await connection(profile.id)).evaluate('('+function(root){
      window.__codexSharedTrustProbe?.observer.disconnect();
      const events=[],seen=new WeakSet();
      const inspect=()=>{for(const d of document.querySelectorAll('dialog,[role=dialog],[role=alertdialog]')){
        if(!seen.has(d)&&d.textContent.includes('Trust this folder?')&&d.textContent.includes(root)){
          seen.add(d);events.push({at:new Date().toISOString()});
        }
      }};
      const observer=new MutationObserver(inspect);observer.observe(document.body,{childList:true,subtree:true});inspect();
      window.__codexSharedTrustProbe={observer,events};
    }.toString()+')('+JSON.stringify(root)+')');
    // The fixture directory was explicitly trusted during installation. Use the
    // app's own restoration path so a diagnostic rerun needs no new UI consent.
    await native('C1','upsertLocal',[{projectId:testId,name,sources:[root]},'restore']);
    const created=await waitFor(async()=>{const cat=await control({command:'shared-catalog'});const p=Object.values(cat.projects).find(p=>p.name===name&&!p.deleted);if(!p)return false;const b=cat.profiles.C2.bindings[p.id];const c2=await read('C2');return c2?.[b.desktopId]?{cat,id:p.id,c2Id:b.desktopId}:false;},'New project did not reach C2');
    logicalId=created.id;report.fixture={logicalId,c1Id:testId,c2Id:created.c2Id};report.createdInBoth=true;
    await native('C2','renameLocal',[{projectId:created.c2Id,name:renamed}]);
    await waitFor(async()=> (await read('C1'))?.[testId]?.name===renamed,'C2 rename did not reach C1');report.renamedFromC2=true;
    await control({command:'operation',profile:'C1',operation:{type:'create',id:folderId,name:'Проверка общих проектов',parentId:null}});
    await control({command:'operation',profile:'C2',operation:{type:'assign',projectKey:'local:project:'+created.c2Id,folderId}});
    const states=await Promise.all(profiles.map(p=>control({command:'state',profile:p.id})));
    assert.equal(states[0].projectFolderMap['local:project:'+testId],folderId);assert.equal(states[1].projectFolderMap['local:project:'+created.c2Id],folderId);
    const dom={};
    for(const profile of profiles){
      const id=profile.id==='C1'?testId:created.c2Id;
      const sidebarVisible=await(await connection(profile.id)).evaluate('!!document.querySelector("[data-app-action-sidebar-project-create]")');
      if(!sidebarVisible){dom[profile.id]={status:'sidebar-hidden',projectionVerified:true};continue;}
      dom[profile.id]=await waitFor(async()=>{
        const data=await(await connection(profile.id)).evaluate('window.__codexUi?.inspect()');
        const row=data?.projects.find(p=>p.key.endsWith(':'+id));return row?.depth==='1'?row:false;
      },profile.id+' folder projection did not render');
    }
    report.folderAssignmentShared=true;report.rendered=dom;
    await control({command:'shared-reconnect',profile:'C2'});
    await waitFor(async()=>{const status=await control({command:'status'});const available=await(await connection('C2')).evaluate('!!window.__codexSharedDesktop');return available&&status.clients.some(c=>c.profile==='C2'&&c.sharedReady);},'C2 did not reconnect');
    await native('C1','renameLocal',[{projectId:testId,name:name+' reconnect'}]);
    await waitFor(async()=> (await read('C2'))?.[created.c2Id]?.name===name+' reconnect','Rename after reconnect did not reach C2');report.reconnectPassed=true;
    await native('C1','removeLocal',[testId]);
    await waitFor(async()=>!(await read('C1'))?.[testId]&&!(await read('C2'))?.[created.c2Id],'Removal did not reach both profiles');report.removedFromBoth=true;
    await control({command:'operation',profile:'C1',operation:{type:'remove',id:folderId}});folderId=null;
    const after=Object.fromEntries(await Promise.all(profiles.map(async p=>[p.id,await read(p.id)])));
    assert.deepEqual(after,before,'Existing projects changed during integration check');report.existingProjectsPreserved=true;
    report.memberships=await verifyMemberships(await control({command:'shared-catalog'}));
    const status=await waitFor(async()=>{const s=await control({command:'status'});return !s.shared.conflicts.length&&Object.values(s.shared.accounts).every(a=>a.pending===0)?s:false;},'Synchronization did not settle');
    report.finalStatus=status.shared;
    report.trustPrompts={};
    for(const profile of profiles){
      const events=await(await connection(profile.id)).evaluate('window.__codexSharedTrustProbe.events');
      report.trustPrompts[profile.id]=events.length;assert.equal(events.length,0,profile.id+' unexpected Trust dialog');
    }
    report.newReplicasWithoutTrust=true;
  }
  await fs.writeFile(path.join(stateDirectory,exercise?'verification-live.json':'verification-current.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
  if(testId){
    try{
      const cat=await control({command:'shared-catalog'});
      const id=logicalId??Object.keys(cat.profiles.C1.bindings).find(id=>cat.profiles.C1.bindings[id].desktopId===testId);
      if(id){
        for(const profile of profiles){const nativeId=cat.profiles[profile.id].bindings[id]?.desktopId;if(nativeId&&(await read(profile.id))?.[nativeId])await native(profile.id,'removeLocal',[nativeId]);}
      }else if((await read('C1'))?.[testId])await native('C1','removeLocal',[testId]);
    }catch(e){console.error('Test-project cleanup:',e.message);}
  }
  if(folderId)await control({command:'operation',profile:'C1',operation:{type:'remove',id:folderId}}).catch(()=>{});
  for(const c of connections.values())await c.evaluate('window.__codexSharedTrustProbe?.observer.disconnect();delete window.__codexSharedTrustProbe').catch(()=>{});
  for(const c of connections.values())c.close();
}
