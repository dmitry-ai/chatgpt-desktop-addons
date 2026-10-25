import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rootKey,fields,identity} from './catalog.mjs';

function workspaceKey(value){
  if(typeof value!=='string'||!value)throw Error('Неизвестный рабочий каталог');
  if(value.startsWith('file:'))value=fileURLToPath(value);
  if(value.startsWith('\\\\?\\UNC\\'))value='\\\\'+value.slice(8);
  else if(value.startsWith('\\\\?\\'))value=value.slice(4);
  return rootKey(value);
}

function hasConversations(message){
  const error=Error(message);error.code='PROJECT_HAS_CONVERSATIONS';return error;
}

async function readUnlinked(file){
  for(let current=path.resolve(file);;current=path.dirname(current)){
    if((await fs.lstat(current)).isSymbolicLink())throw Error('Связанные доказательства создания проекта сохранены');
    if(path.dirname(current)===current)break;
  }
  return (await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'');
}

export async function initializationState(root,{primary,policyFile}={}){
  try{return JSON.parse(await readUnlinked(path.join(root,'ꘖ','project.json')));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(!primary){
    const policy=JSON.parse(await readUnlinked(policyFile??fileURLToPath(new URL('./trust-policy.json',import.meta.url))));
    primary=path.dirname(policy.upworkRuntime);
  }
  const agents=path.join(root,'.agents');
  for(const kind of ['rules','skills','agents']){
    const manifest=JSON.parse(await readUnlinked(path.join(agents,kind+'.json')));
    if(!Array.isArray(manifest.entries)||!manifest.entries.some(entry=>typeof entry?.path==='string'&&
      workspaceKey(path.resolve(agents,entry.path))===workspaceKey(path.resolve(primary,kind))))throw Error('Не подтверждены общие манифесты старого /upwork-init');
  }
  const rule=await readUnlinked(path.join(agents,'rules','90-project.md'));
  const kb=await readUnlinked(path.join(root,'KB','Project.md'));
  const ids=text=>[...text.matchAll(/https?:\/\/(?:www\.)?upwork\.com\/jobs\/[^\s`"<>]*?(~[A-Za-z0-9]+)/g)].map(m=>m[1]);
  const ruleIds=new Set(ids(rule));
  const current=/^#\s*2\.\s*Текущий проект клиента[^\n]*\n([\s\S]*?)(?=^#\s|(?![\s\S]))/m.exec(kb);
  const job=current?ids(current[1])[0]:null;
  if(ruleIds.size!==1||!job||!ruleIds.has(job))throw Error('Правило старого проекта и текущая вакансия KB не совпадают');
  if(!/^~\d+$/.test(job))throw Error('Неподдержанный исторический ID сохранён без очистки');
  return {initialized:true,job_id:job,initialization_basis:'legacy-manifests-rule-and-kb'};
}

export async function checkAge(root,marker,now=Date.now()){
  let created;
  if(marker.created_at){
    if(typeof marker.created_at!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(marker.created_at))throw Error('Неизвестный часовой пояс created_at');
    created=Date.parse(marker.created_at);
  }else{
    // Windows directory birth time is the same legacy lower-risk source used
    // by the producer; it also protects recently copied historical projects.
    created=(await fs.stat(root)).birthtimeMs;
  }
  if(!Number.isFinite(created)||created<=0||now-created<=72*3600*1000)throw Error('Проект ещё не старше 72 часов');
}

export function pruneProject(state,id){
  const byId=new Map(state.folders.map(f=>[f.id,f])),affected=new Set();
  let folder=state.projectFolderMap[id];
  while(folder){
    if(affected.has(folder)||!byId.has(folder))throw Error('Некорректная ветка Folders');
    affected.add(folder);folder=byId.get(folder).parentId;
  }
  delete state.projectFolderMap[id];
  const removed=[];
  while(true){
    const empty=[...affected].filter(id=>byId.has(id)&&!Object.values(state.projectFolderMap).includes(id)&&![...byId.values()].some(f=>f.parentId===id));
    if(!empty.length)break;
    for(const id of empty){byId.delete(id);removed.push(id);}
  }
  state.folders=state.folders.filter(f=>byId.has(f.id));
  delete state.projects[id];state.projectOrder=state.projectOrder.filter(x=>x!==id);
  state.conflicts=state.conflicts.filter(c=>c.projectId!==id);
  state.operations=state.operations.filter(o=>o.projectId!==id);
  for(const profile of Object.values(state.profiles)){
    delete profile.bindings[id];
    profile.collapsedFolderIds=profile.collapsedFolderIds.filter(id=>byId.has(id));
    for(const [alias,target]of Object.entries(profile.folderAliases??{}))if(!byId.has(target))delete profile.folderAliases[alias];
  }
  return removed;
}

export async function checkConversations(profiles,root,bindings){
  const {DatabaseSync}=await import('node:sqlite');
  const key=workspaceKey(root),counts={};
  for(const profile of profiles){
    const databases=(await fs.readdir(profile.home)).filter(name=>/^state_.*\.sqlite$/.test(name));
    if(!databases.length)throw Error('Недоступна история Codex '+profile.id);
    const found=new Set();
    for(const name of databases){
      const file=path.join(profile.home,name);
      if((await fs.lstat(file)).isSymbolicLink())throw Error('Связанная база Codex сохранена');
      const db=new DatabaseSync(file,{readOnly:true});
      try{
        for(const row of db.prepare('SELECT id,project_id,cwd FROM threads').all()){
          if(typeof row.cwd!=='string'||!row.cwd)throw Error('Неизвестный формат cwd в истории Codex');
          const cwd=workspaceKey(row.cwd);
          if(row.project_id===bindings[profile.id]||cwd===key||cwd.startsWith(key+'/')||cwd.startsWith(key+'\\'))found.add(row.id);
        }
      }finally{db.close();}
    }
    counts[profile.id]=found.size;
  }
  if(Object.values(counts).some(Boolean))throw hasConversations('Проект имеет беседы Codex: '+JSON.stringify(counts));
  return counts;
}

export async function checkHistories(profiles,root,bindings,antigravity){
  const counts=await checkConversations(profiles,root,bindings);
  if(typeof antigravity?.database!=='string'||!Array.isArray(antigravity.projectIds))throw Error('Не указана история Antigravity');
  const {DatabaseSync}=await import('node:sqlite');
  const key=workspaceKey(root),db=new DatabaseSync(antigravity.database,{readOnly:true});
  let count=0;
  try{
    for(const row of db.prepare('SELECT project_id,workspace_uris FROM conversation_summaries').all()){
      const uris=row.workspace_uris?JSON.parse(row.workspace_uris):[];
      if(!Array.isArray(uris))throw Error('Неизвестный формат рабочих каталогов Antigravity');
      const belongs=uri=>{
        if(typeof uri!=='string'||!uri)throw Error('Неизвестный рабочий каталог Antigravity');
        const cwd=workspaceKey(uri);
        return cwd===key||cwd.startsWith(key+'/')||cwd.startsWith(key+'\\');
      };
      if(antigravity.projectIds.includes(row.project_id)||uris.some(belongs))count++;
    }
  }finally{db.close();}
  if(count)throw hasConversations('Проект имеет беседы Antigravity: '+count);
  return {...counts,antigravity:count};
}

export function validateRequest(state,profiles,spec){
  if(!spec||typeof spec.sharedId!=='string'||!Array.isArray(spec.rootPaths)||spec.rootPaths.length!==1)throw Error('Некорректный запрос очистки');
  const project=state.projects[spec.sharedId];
  if(!project)return null;
  if(identity(project)!==identity(spec))throw Error('Корни проекта изменились перед очисткой');
  if(Object.keys(state.profiles).sort().join()!==profiles.map(p=>p.id).sort().join())throw Error('Неполный список профилей очистки');
  if(state.conflicts.some(c=>c.projectId===project.id)||state.operations.some(o=>o.projectId===project.id))throw Error('Проект имеет конфликт или незавершённую операцию');
  for(const profile of profiles)if(state.profiles[profile.id].bindings[project.id]?.desktopId!==spec.bindings?.[profile.id])throw Error('Привязки проекта изменились перед очисткой');
  return project;
}

async function restoreCleanup(sync,spec){
  const clients=sync.profiles.map(profile=>sync.getClients().find(c=>c.profile.id===profile.id&&c.installed&&c.sharedReady&&!c.cdp.closed));
  const offline=clients.some(c=>!c);
  const snapshots=await Promise.all(clients.map(c=>c?c.cdp.evaluate('window.__codexSharedDesktop.read()',10000):null));
  await sync.store.transact(state=>{
    const project=validateRequest(state,sync.profiles,spec);if(!project)return;
    if(!project.cleanupHold)return;
    delete project.deleted;if(!offline)delete project.cleanupHold;
    let source=null;
    for(let i=0;i<clients.length;i++){
      if(!clients[i])continue;
      const profile=clients[i].profile.id,binding=state.profiles[profile].bindings[project.id];
      if(snapshots[i][binding.desktopId])source??=profile;
      else {binding.lastSeen=null;binding.known=false;binding.missing=false;}
    }
    if(source)project.registrationSource=source;
  });
  if(offline)return {complete:false,status:'preserved-partial',message:'Откройте оба профиля Codex для восстановления прерванной очистки'};
  return {complete:true,status:'preserved',restoration_requested:true};
}

export async function cleanupProject(sync,spec,{check=checkHistories}={}){
  if(sync.cleaning)throw Error('Очистка уже выполняется');
  sync.cleaning=true;
  let held=false,prior=null;
  try{
    // Drain existing collectors before forgetting an ID, so an old native
    // snapshot cannot import the just-removed project back into the catalogue.
    await Promise.all([...sync.runners.values()].filter(r=>r.running).map(r=>r.promise));
    const {store,profiles}=sync;
    let project=validateRequest(store.state,profiles,spec);
    if(!project)return {complete:true,already_absent:true,removed_folders:[]};
    prior={deleted:project.deleted,cleanupHold:project.cleanupHold};
    if(spec.preserve===true)return await restoreCleanup(sync,spec);
    const clients=profiles.map(profile=>sync.getClients().find(c=>c.profile.id===profile.id&&c.installed&&c.sharedReady&&!c.cdp.closed));
    const offline=profiles.filter((_,i)=>!clients[i]).map(p=>p.id);
    if(offline.length)return {complete:false,status:'pending',offline_profiles:offline,
      message:'Откройте указанные профили Codex и повторите /upwork-cleanup'};
    const root=spec.rootPaths[0],marker=await initializationState(root,{policyFile:sync.trustPolicy?.file});
    if(marker.initialized!==true||!/^~\d+$/.test(marker.job_id))throw Error('Не подтверждено создание проекта через /upwork-init');
    await checkAge(root,marker);
    await check(profiles,root,spec.bindings,spec.antigravity);
    const expected=fields(project),removed=[];
    for(const client of clients){
      const snapshot=await client.cdp.evaluate('window.__codexSharedDesktop.read()',10000);
      const native=snapshot[spec.bindings[client.profile.id]];
      if(native&&identity(native)!==identity(project))throw Error('Нативные корни изменились перед очисткой');
      if(native&&JSON.stringify(fields(native))!==JSON.stringify(expected))throw Error('Нативный проект изменился перед очисткой');
      for(const value of Object.values(snapshot))if(value.id!==spec.bindings[client.profile.id]&&identity(value)===identity(project))throw Error('Неоднозначная нативная регистрация');
      if(spec.commit===true&&native)throw Error('Нативный проект ещё присутствует перед фиксацией очистки');
    }
    // A persistent hold prevents recreation if the helper stops after removing
    // only one profile. It dispatches no delayed destructive operations.
    if(spec.commit!==true)await store.transact(state=>{
      project=validateRequest(state,profiles,spec);
      project.deleted=true;project.cleanupHold=true;
    });
    held=spec.commit!==true;
    for(const client of spec.commit===true?[]:clients){
      await check(profiles,root,spec.bindings,spec.antigravity);
      const id=spec.bindings[client.profile.id];
      const reply=await client.cdp.evaluate('window.__codexSharedDesktop.remove('+JSON.stringify(id)+','+JSON.stringify(expected)+')',10000);
      if(reply?.removed!==true)throw Error('Приложение не подтвердило удаление проекта');
      removed.push(client.profile.id);
    }
    await check(profiles,root,spec.bindings,spec.antigravity);
    for(const client of clients){
      const snapshot=await client.cdp.evaluate('window.__codexSharedDesktop.read()',10000);
      if(snapshot[spec.bindings[client.profile.id]])throw Error('Проект ещё присутствует в Codex');
    }
    if(spec.deferCommit===true)return {complete:true,awaiting_commit:true,metadata_removed:false,removed_profiles:removed,removed_folders:[]};
    const {result:folders}=await store.transact(state=>{
      const current=validateRequest(state,profiles,spec);
      if(JSON.stringify(fields(current))!==JSON.stringify(expected))throw Error('Общий проект изменился во время очистки');
      return pruneProject(state,spec.sharedId);
    });
    return {complete:true,removed_profiles:removed,metadata_removed:true,removed_folders:folders};
  }catch(error){
    if(held||prior?.cleanupHold){
      await restoreCleanup(sync,spec);
    }
    throw error;
  }finally{
    sync.cleaning=false;await sync.notify();sync.wakeAll();
  }
}
