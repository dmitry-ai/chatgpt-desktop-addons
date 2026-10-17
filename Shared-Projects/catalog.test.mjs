import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {CatalogStore,migrateSeeds,observeProjects,planOperation,acknowledge,markStarted,failOperation,resumeSync,folderOperation,projectState,pendingCount,resolveConflict,identity,rootKey,stateDirectory,ensureProject,registrationReceipt,selectRegistrationSources} from './catalog.mjs';
import {findProjectServiceExport,findProjectHostImport,operationLedger} from './desktop.mjs';
const project=(id,name='Project',rootPaths=['C:\\work\\project'])=>({id,name,rootPaths});
const folder=(id,name,parentId=null)=>({id,name,parentId});
const folders=(list=[],map={},collapsed=[])=>({schemaVersion:1,revision:0,folders:list,projectFolderMap:map,collapsedFolderIds:collapsed});
const seed=(id,projects,tree=folders())=>({id,projects:Object.fromEntries(projects.map(p=>[p.id,p])),order:projects.map(p=>p.id),folders:tree});
const pair=()=>migrateSeeds([seed('C1',[project('native-1')],folders([folder('folder-1','Work')],{},['folder-1'])),seed('C2',[project('native-2')],folders([folder('folder-2','Work')]))]);
const snapshot=p=>Object.fromEntries(p.map(p=>[p.id,p]));
const shared=s=>Object.keys(s.projects)[0];

test('producer registration reuses identity, preserves names/IDs and assigns one common branch',()=>{
 const s=pair(),before=structuredClone(s.profiles),id=shared(s);
 const spec={name:'Suggested name',rootPaths:['c:/WORK/project/'],folderPath:['Upwork','Proposals','2026','10','15']};
 const first=ensureProject(s,'C1',spec),snapshot=structuredClone(s);
 const second=ensureProject(s,'C2',spec);
 assert.equal(first.shared_id,id);assert.equal(second.shared_id,id);assert.deepEqual(s,snapshot);
 assert.equal(first.project_name,'Project');assert.equal(first.folder_path,'Upwork / Proposals / 2026 / 10 / 15');
 assert.equal(first.profiles.C1.project_id,'native-1');assert.equal(first.profiles.C2.project_id,'native-2');
 assert.deepEqual(s.profiles,before);assert.equal(first.complete,true);
 assert.equal(projectState(s,'C2').projectFolderMap['local:project:native-2'],first.folder_id);
});

test('producer-created project waits for actual source registration before restoring another profile',()=>{
 const s=pair(),spec={name:'New job',rootPaths:['C:/work/new-job'],folderPath:['Upwork','Proposals']};
 const registration=ensureProject(s,'C2',spec),id=registration.shared_id;
 assert.equal(registration.complete,false);assert.equal(planOperation(s,'C1',snapshot([project('native-1')])),null);
 const op=planOperation(s,'C2',snapshot([project('native-2')]));
 assert.equal(op.registration,'sync');assert.equal(op.approvedBy,null);
 acknowledge(s,op,{id:op.desktopId,...op.value});
 const replica=planOperation(s,'C1',snapshot([project('native-1')]));
 assert.equal(replica.registration,'restore');assert.equal(replica.approvedBy,'C2');
 assert.equal(registrationReceipt(s,id,'C2').complete,true);
});

test('producer retry survives pending confirmation and never reuses a deleted project',()=>{
 const s=pair(),spec={name:'Job',rootPaths:['C:/job'],folderPath:['Upwork']};
 const first=ensureProject(s,'C1',spec);const op=planOperation(s,'C1',snapshot([project('native-1')]));markStarted(s,op.id);
 assert.equal(ensureProject(s,'C1',spec).shared_id,first.shared_id);
 assert.equal(planOperation(s,'C1',snapshot([project('native-1')])).id,op.id);
 s.projects[first.shared_id].deleted=true;s.operations=[];
 assert.notEqual(ensureProject(s,'C1',spec).shared_id,first.shared_id);
});

test('migration merges identical roots and folder paths while retaining native IDs and local expansion',()=>{
 const s=pair(),id=shared(s);assert.equal(Object.keys(s.projects).length,1);assert.equal(s.folders.length,1);
 assert.equal(s.profiles.C1.bindings[id].desktopId,'native-1');assert.equal(s.profiles.C2.bindings[id].desktopId,'native-2');
 assert.deepEqual(s.profiles.C1.collapsedFolderIds,['folder-1']);assert.deepEqual(s.profiles.C2.collapsedFolderIds,[]);
 assert.equal(s.profiles.C2.folderAliases['folder-2'],'folder-1');
});
test('assignment is projected onto the different native IDs of both profiles',()=>{
 const s=pair();folderOperation(s,'C1',{type:'assign',projectKey:'local:project:native-1',folderId:'folder-1'});
 assert.equal(projectState(s,'C2').projectFolderMap['local:project:native-2'],'folder-1');
 folderOperation(s,'C2',{type:'collapse',id:'folder-1',collapsed:true});assert.deepEqual(s.profiles.C2.collapsedFolderIds,['folder-1']);
 folderOperation(s,'C1',{type:'collapse',id:'folder-1',collapsed:false});assert.deepEqual(s.profiles.C2.collapsedFolderIds,['folder-1']);
});
test('removing a folder lifts shared assignments and clears expansion in every profile',()=>{
 const s=pair();folderOperation(s,'C1',{type:'assign',projectKey:'local:project:native-1',folderId:'folder-1'});
 folderOperation(s,'C1',{type:'remove',id:'folder-1'});assert.deepEqual(s.projectFolderMap,{});assert.deepEqual(s.profiles.C1.collapsedFolderIds,[]);
});
test('identity includes every root in order, retaining primary-folder semantics and POSIX case',()=>{
 assert.equal(rootKey('C:/Work/Test/'),rootKey('c:\\work\\test'));
 assert.equal(rootKey('//Server/Share/Test/'),rootKey('\\\\server\\share\\test'));
 assert.notEqual(rootKey('/work/A'),rootKey('/work/a'));
 assert.notEqual(identity(project('a','A',['C:\\one','C:\\two'])),identity(project('b','B',['C:\\two','C:\\one'])));
 const s=migrateSeeds([seed('C1',[project('a','A',['C:\\one','C:\\two']),project('b','B',['C:\\one'])]),seed('C2',[])]);assert.equal(Object.keys(s.projects).length,2);assert.equal(pendingCount(s,'C2'),2);
});
test('new native projects get persistent bindings for the other profile',()=>{
 const s=pair();observeProjects(s,'C1',snapshot([project('native-1'),project('new','Other',['C:\\work\\other'])]));
 assert.equal(Object.keys(s.projects).length,2);const op=planOperation(s,'C2',snapshot([project('native-2')]));assert.equal(op.value.name,'Other');
 assert.equal(op.registration,'restore');assert.equal(op.approvedBy,'C1');
 assert.equal(planOperation(s,'C2',snapshot([project('native-2')])).id,op.id);
 acknowledge(s,op,{id:op.desktopId,...op.value});assert.equal(pendingCount(s,'C2'),0);
});
test('manual unapproved root changes do not grant silent registration in another profile',()=>{
 const s=migrateSeeds([seed('C1',[project('a')]),seed('C2',[])]),id=shared(s);
 s.projects[id].rootPaths=['C:\\different'];
 const op=planOperation(s,'C2',{});assert.equal(op.registration,'sync');assert.equal(op.approvedBy,null);
});
test('rename propagates without echo and preserves the original target ID',()=>{
 const s=pair();observeProjects(s,'C1',snapshot([project('native-1','Changed')]));
 const op=planOperation(s,'C2',snapshot([project('native-2')]));assert.equal(op.desktopId,'native-2');assert.equal(op.value.name,'Changed');
 acknowledge(s,op,{id:op.desktopId,...op.value});observeProjects(s,'C2',snapshot([project('native-2','Changed')]));
 assert.equal(s.conflicts.length,0);assert.equal(planOperation(s,'C1',snapshot([project('native-1','Changed')])),null);
});
test('concurrent incompatible renames retain both values and pause writes until resolved',()=>{
 const s=pair();observeProjects(s,'C1',snapshot([project('native-1','From C1')]));observeProjects(s,'C2',snapshot([project('native-2','From C2')]));
 assert.equal(s.conflicts.length,1);assert.equal(s.conflicts[0].sharedValue,'From C1');assert.equal(s.conflicts[0].localValue,'From C2');
 assert.equal(planOperation(s,'C2',snapshot([project('native-2','From C2')])),null);
 resolveConflict(s,s.conflicts[0].id,'local');assert.equal(s.projects[shared(s)].name,'From C2');assert.equal(s.conflicts.length,0);
 assert.equal(planOperation(s,'C1',snapshot([project('native-1','From C1')])).value.name,'From C2');
});
test('missing data never causes shared deletion or automatic re-creation',()=>{
 const s=pair();observeProjects(s,'C2',{});assert.equal(s.projects[shared(s)].deleted,undefined);assert.equal(s.conflicts[0].kind,'missing');
 assert.equal(planOperation(s,'C2',{}),null);resolveConflict(s,s.conflicts[0].id,'shared');const op=planOperation(s,'C2',{});assert.equal(op.desktopId,'native-2');
});
test('an application ID migration rebinds a unique matching project without making another project',()=>{
 const s=pair();observeProjects(s,'C2',snapshot([project('migrated')]));assert.equal(Object.keys(s.projects).length,1);
 assert.equal(s.profiles.C2.bindings[shared(s)].desktopId,'migrated');assert.equal(s.conflicts.length,0);
});
test('only an explicit native removal is propagated, and stale replicas cannot resurrect it',()=>{
 const s=pair();const before=snapshot([project('native-1')]);observeProjects(s,'C1',{}, {method:'removeLocal',before,after:{}});
 assert.equal(s.projects[shared(s)].deleted,true);observeProjects(s,'C2',snapshot([project('native-2')]));assert.equal(s.projects[shared(s)].deleted,true);
 const op=planOperation(s,'C2',snapshot([project('native-2')]));assert.equal(op.type,'remove');acknowledge(s,op,{removed:true});assert.equal(pendingCount(s,'C2'),0);
});
test('native undo restores the same logical project',()=>{
 const s=pair(),id=shared(s);observeProjects(s,'C1',{}, {method:'removeLocal',before:snapshot([project('native-1')]),after:{}});
 observeProjects(s,'C1',snapshot([project('native-1')]),{method:'upsertLocal',before:{},after:snapshot([project('native-1')])});assert.equal(s.projects[id].deleted,undefined);assert.equal(Object.keys(s.projects).length,1);
});
test('a lost acknowledgement is recovered by reading the result, with no second creation',()=>{
 const s=migrateSeeds([seed('C1',[project('a')]),seed('C2',[])]),op=planOperation(s,'C2',{});
 observeProjects(s,'C2',snapshot([{id:op.desktopId,...op.value}]));assert.equal(s.operations.length,0);assert.equal(planOperation(s,'C2',snapshot([{id:op.desktopId,...op.value}])),null);
});
test('an in-flight native operation retains its ID and precondition when the shared name changes',()=>{
 const s=pair(),id=shared(s);observeProjects(s,'C1',snapshot([project('native-1','First')]));
 const op=markStarted(s,planOperation(s,'C2',snapshot([project('native-2')])).id);
 observeProjects(s,'C1',snapshot([project('native-1','Second')]));
 assert.deepEqual(planOperation(s,'C2',snapshot([project('native-2')])),op);
 observeProjects(s,'C2',snapshot([project('native-2','First')]));
 assert.equal(s.projects[id].name,'Second');assert.equal(s.operations.length,0);
 assert.equal(planOperation(s,'C2',snapshot([project('native-2','First')])).value.name,'Second');
});
test('a lost removal acknowledgement clears the pending binding without re-creating anything',()=>{
 const s=pair();observeProjects(s,'C1',{}, {method:'removeLocal',before:snapshot([project('native-1')]),after:{}});
 markStarted(s,planOperation(s,'C2',snapshot([project('native-2')])).id);
 observeProjects(s,'C2',{});assert.equal(s.operations.length,0);assert.equal(pendingCount(s,'C2'),0);assert.equal(planOperation(s,'C2',{}),null);
});
test('a declined native confirmation pauses the profile until an explicit retry',()=>{
 const s=migrateSeeds([seed('C1',[project('a')]),seed('C2',[])]),op=planOperation(s,'C2',{});
 failOperation(s,op.id,'Приложение не подтвердило сохранение проекта',{pause:true});
 const restarted=JSON.parse(JSON.stringify(s));assert.equal(planOperation(restarted,'C2',{}),null);
 resumeSync(restarted);assert.ok(planOperation(restarted,'C2',{}));
});
test('pending native confirmation is submitted only once, including helper reconnects',async()=>{
 const tasks=new Map();let calls=0,finish,events=0;
 const ledger=operationLedger(tasks,()=>{calls++;return new Promise(resolve=>finish=resolve)},()=>events++);
 const op={id:'one',type:'upsert',desktopId:'fixed',value:{name:'Test',rootPaths:['C:/test']},expected:null};
 assert.deepEqual(ledger.start(op),{state:'pending'});await new Promise(setImmediate);
 assert.deepEqual(ledger.start(op),{state:'pending'});
 const reconnected=operationLedger(tasks,()=>{throw Error('Duplicate call')},()=>{});
 assert.deepEqual(reconnected.start(op),{state:'pending'});ledger.retain([]);assert.equal(tasks.size,1);
 finish({id:'fixed'});await new Promise(setImmediate);
 assert.deepEqual(reconnected.start(op),{state:'done',result:{id:'fixed'}});assert.equal(calls,1);assert.equal(events,1);
 reconnected.forget(op.id);assert.equal(tasks.size,0);
});
test('native task errors are inspectable and conflicts cannot start a new native call',async()=>{
 const tasks=new Map(),ledger=operationLedger(tasks,()=>{throw Error('Declined')},()=>{});
 const op={id:'one',type:'upsert',desktopId:'fixed',value:{name:'Test',rootPaths:['C:/test']},expected:null};
 assert.deepEqual(ledger.start(op,false),{state:'blocked'});assert.equal(tasks.size,0);
 ledger.start(op);await new Promise(setImmediate);assert.deepEqual(ledger.start(op),{state:'failed',error:'Declined'});
 assert.throws(()=>ledger.start({...op,desktopId:'other'}),/reused/);ledger.retain([]);assert.equal(tasks.size,0);
});
test('account-owned cloud projects stay outside this local catalogue',()=>{
 const cloud={...project('cloud'),chatGptBacking:{accountId:'account'}};const s=migrateSeeds([seed('C1',[project('a'),cloud]),seed('C2',[])]);
 observeProjects(s,'C2',snapshot([{...project('cloud-2'),rootPaths:[],cloudBacked:true}]));assert.equal(Object.keys(s.projects).length,1);
});
test('desktop discovery handles changed minified identifiers and rejects ambiguous exports',()=>{
 const source='import{thing as xx}from`./shared-new.js`;function ab$(){let q=xx.projects;if(q==null)throw Error(`unavailable`);return q}export{ab$ as newAlias}';
 assert.equal(findProjectServiceExport(source),'newAlias');assert.deepEqual(findProjectHostImport(source),{name:'thing',url:'./shared-new.js'});
 assert.throws(()=>findProjectServiceExport(source.replace('ab$ as newAlias','ab$ as one,ab$ as two')),/однозначный/);
});
test('serialized writes preserve edits from both accounts and corrupt JSON is never overwritten',async t=>{
 const root=path.join(stateDirectory,'tests');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'catalog-'));
 t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(root)+path.sep));await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'catalog.json');await fs.writeFile(file,JSON.stringify(pair()));const store=new CatalogStore(file);await store.load([]);
 await Promise.all([store.transact(s=>folderOperation(s,'C1',{type:'create',id:'new-1',name:'One',parentId:null})),store.transact(s=>folderOperation(s,'C2',{type:'create',id:'new-2',name:'Two',parentId:null}))]);
 assert.equal(store.state.folders.length,3);
 await store.transact(s=>observeProjects(s,'C1',snapshot([project('native-1','Changed while C2 is closed')])));
 const {result:waiting}=await store.transact(s=>planOperation(s,'C2',snapshot([project('native-2')])));
 const restarted=new CatalogStore(file);await restarted.load([]);assert.equal(restarted.state.folders.length,3);
 assert.equal(planOperation(restarted.state,'C2',snapshot([project('native-2')])).id,waiting.id);
 assert.equal(pendingCount(restarted.state,'C2'),1);
 await fs.writeFile(file,'{broken');await assert.rejects(store.transact(s=>s.revision++));assert.equal(await fs.readFile(file,'utf8'),'{broken');assert.equal(store.state.folders.length,3);
});

test('a pending trusted producer switches from closed C2 to available C1 without replacing IDs',()=>{
 const s=migrateSeeds([seed('C1',[]),seed('C2',[])]);
 const spec={name:'Upwork',rootPaths:['C:\\work\\upwork\\code\\proposals\\daily\\one'],folderPath:['Upwork'],trustPolicy:'upwork-daily'};
 const pending=ensureProject(s,'C2',spec),id=pending.shared_id;
 const ids=Object.fromEntries(Object.entries(s.profiles).map(([name,p])=>[name,p.bindings[id].desktopId]));
 assert.equal(pending.status,'pending');assert.equal(pending.registration_source,'C2');
 const again=ensureProject(s,'C2',spec,{availableProfiles:['C1']});
 assert.equal(again.shared_id,id);assert.equal(again.registration_source,'C1');
 assert.deepEqual(Object.fromEntries(Object.entries(s.profiles).map(([name,p])=>[name,p.bindings[id].desktopId])),ids);
 assert.equal(planOperation(s,'C2',{}),null);
 const source=planOperation(s,'C1',{});assert.equal(source.registration,'sync');assert.equal(source.approvedBy,null);
 acknowledge(s,source,{id:source.desktopId,...source.value});
 const copy=planOperation(s,'C2',{});assert.equal(copy.registration,'restore');assert.equal(copy.approvedBy,'C1');
});

test('source selection preserves in-flight acceptance and explicit untrusted remains queued without dispatch',()=>{
 const s=migrateSeeds([seed('C1',[]),seed('C2',[])]);
 const spec={name:'Upwork',rootPaths:['C:\\daily\\one'],folderPath:['Upwork'],trustPolicy:'upwork-daily'};
 const {shared_id:id}=ensureProject(s,'C2',spec);
 const op=markStarted(s,planOperation(s,'C2',{}).id);
 selectRegistrationSources(s,['C1']);assert.equal(s.projects[id].registrationSource,'C2');
 failOperation(s,op.id,'UNTRUSTED_PROJECT: exact root',{registrationBlock:'untrusted'});
 const restarted=JSON.parse(JSON.stringify(s));
 assert.equal(registrationReceipt(restarted,id,'C2').status,'untrusted');
 assert.equal(planOperation(restarted,'C2',{}),null);assert.equal(pendingCount(restarted,'C2'),1);
 resumeSync(restarted);assert.ok(planOperation(restarted,'C2',{}));
});
