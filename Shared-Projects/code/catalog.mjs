import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {applyOperation,validate as validateFolders,emptyState} from '../../Folders/code/store.mjs';
import {backupProfiles} from './backup.mjs';

export const stateDirectory=path.join(path.dirname(fileURLToPath(import.meta.url)),'state');
export const catalogFile=path.join(stateDirectory,'catalog.json');
const clone=value=>structuredClone(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const fields=p=>({name:p.name,rootPaths:[...p.rootPaths]});
const local=p=>p && !p.cloudBacked && !p.chatGptBacking && !p.chatGptBackingCreation && !p.retiredChatGptBacking;
export function rootKey(root){
  return /^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(root)?path.win32.normalize(root).replace(/[\\/]+$/,'').toLowerCase():path.posix.normalize(root).replace(/\/$/,'');
}
export const identity=p=>JSON.stringify(p.rootPaths.map(rootKey));
const nativeKey=id=>'local:project:'+id;
function validProject(p){return p && typeof p.id==='string' && p.id && typeof p.name==='string' && p.name.trim() && Array.isArray(p.rootPaths) && p.rootPaths.length && p.rootPaths.every(r=>typeof r==='string'&&r&&(path.win32.isAbsolute(r)||path.posix.isAbsolute(r)));}
function conflict(state,value){
  const key=JSON.stringify([value.kind,value.projectId,value.profile,value.field]);
  const existing=state.conflicts.find(c=>c.key===key);
  if(existing){Object.assign(existing,value);return;}
  state.conflicts.push({id:randomUUID(),key,createdAt:new Date().toISOString(),...value});
}
function ensureBindings(state){
  for(const profile of Object.values(state.profiles))for(const project of Object.values(state.projects)){
    if(!project.deleted && !profile.bindings[project.id])profile.bindings[project.id]={desktopId:randomUUID(),lastSeen:null,known:false};
  }
}
function logicalForNative(state,profile,key){
  if(key.startsWith('shared:') && state.projects[key.slice(7)])return key.slice(7);
  for(const [id,binding]of Object.entries(state.profiles[profile].bindings))if(key===binding.desktopId||key.endsWith(':'+binding.desktopId))return id;
  throw Error('Проект ещё не сопоставлен между профилями');
}

export function validateCatalog(state){
  if(state?.schemaVersion!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!state.projects||!state.profiles||!Array.isArray(state.projectOrder)||!Array.isArray(state.conflicts)||!Array.isArray(state.operations))throw Error('Некорректный формат общего каталога');
  for(const [id,p]of Object.entries(state.projects)){
    if(id!==p.id||!validProject(p))throw Error('Некорректный общий проект');
    if(p.trustPolicy!==undefined&&p.trustPolicy!=='upwork-daily')throw Error('Неизвестная политика доверия проекта');
  }
  if(new Set(state.projectOrder).size!==state.projectOrder.length||state.projectOrder.some(id=>!state.projects[id]))throw Error('Некорректный порядок общих проектов');
  validateFolders({schemaVersion:1,revision:state.revision,folders:state.folders,projectFolderMap:state.projectFolderMap,collapsedFolderIds:[]});
  for(const id of Object.keys(state.projectFolderMap))if(!state.projects[id])throw Error('Папка ссылается на неизвестный проект');
  for(const profile of Object.values(state.profiles)){
    if(!profile.bindings||!Array.isArray(profile.collapsedFolderIds))throw Error('Некорректные привязки профиля');
    if(profile.pauseReason!==undefined&&typeof profile.pauseReason!=='string')throw Error('Некорректная причина приостановки');
    const ids=new Set();
    for(const [id,b]of Object.entries(profile.bindings)){
      if(!state.projects[id]||typeof b.desktopId!=='string'||!b.desktopId||ids.has(b.desktopId))throw Error('Повторная или неизвестная привязка проекта');
      ids.add(b.desktopId);if(b.lastSeen!==null&&(!b.lastSeen||typeof b.lastSeen.name!=='string'||!Array.isArray(b.lastSeen.rootPaths)))throw Error('Некорректное состояние проекта профиля');
    }
    if(profile.collapsedFolderIds.some(id=>!state.folders.some(f=>f.id===id)))throw Error('Неизвестная свёрнутая папка');
  }
  for(const op of state.operations)if(!state.projects[op.projectId]||!state.profiles[op.profile]||!['upsert','remove'].includes(op.type))throw Error('Некорректная ожидающая операция');
  return state;
}

export function migrateSeeds(seeds){
  const state={schemaVersion:1,revision:1,createdAt:new Date().toISOString(),projects:{},projectOrder:[],folders:[],projectFolderMap:{},profiles:{},conflicts:[],operations:[],migration:{profiles:seeds.map(s=>s.id)}};
  const folderPaths=new Map();
  for(const seed of seeds){
    const oldFolders=validateFolders(seed.folders??emptyState());
    const profile=state.profiles[seed.id]={bindings:{},collapsedFolderIds:[],folderAliases:{}};
    const projects=Object.values(seed.projects??{}).filter(local);
    const byId=new Map(projects.map(p=>[p.id,p]));
    const ordered=[...new Set([...(seed.order??[]),...byId.keys()])].map(id=>byId.get(id)).filter(Boolean);
    for(const p of ordered){
      if(!validProject(p))throw Error('Некорректный исходный проект '+p.id);
      const matches=Object.values(state.projects).filter(q=>identity(q)===identity(p)&&!profile.bindings[q.id]);
      if(matches.length>1)throw Error('Неоднозначное сопоставление проекта '+p.name);
      let shared=matches[0];
      if(!shared){shared={id:randomUUID(),...fields(p)};state.projects[shared.id]=shared;state.projectOrder.push(shared.id);}
      else if(shared.name!==p.name)conflict(state,{kind:'field',projectId:shared.id,profile:seed.id,field:'name',baseValue:shared.name,sharedValue:shared.name,localValue:p.name});
      profile.bindings[shared.id]={desktopId:p.id,lastSeen:fields(p),known:true};
    }
    const oldById=new Map(oldFolders.folders.map(f=>[f.id,f]));
    const folderPath=id=>{const f=oldById.get(id);return [...(f.parentId===null?[]:folderPath(f.parentId)),f.name.normalize('NFKC').toLocaleLowerCase('en-US')];};
    const visit=id=>{
      if(profile.folderAliases[id])return profile.folderAliases[id];
      const old=oldById.get(id),parentId=old.parentId===null?null:visit(old.parentId),key=JSON.stringify(folderPath(id));
      let shared=folderPaths.get(key);
      if(!shared){shared={id:state.folders.some(f=>f.id===id)?randomUUID():id,name:old.name,parentId};state.folders.push(shared);folderPaths.set(key,shared);}
      profile.folderAliases[id]=shared.id;return shared.id;
    };
    for(const f of oldFolders.folders)visit(f.id);
    profile.collapsedFolderIds=oldFolders.collapsedFolderIds.map(id=>profile.folderAliases[id]);
    for(const [key,oldFolder]of Object.entries(oldFolders.projectFolderMap)){
      const match=Object.entries(profile.bindings).find(([,b])=>key===b.desktopId||key.endsWith(':'+b.desktopId));
      if(!match)continue;
      const id=match[0],folder=profile.folderAliases[oldFolder];
      if(state.projectFolderMap[id]&&state.projectFolderMap[id]!==folder)conflict(state,{kind:'folder',projectId:id,profile:seed.id,field:'folder',sharedValue:state.projectFolderMap[id],localValue:folder});
      else state.projectFolderMap[id]=folder;
    }
  }
  ensureBindings(state);return validateCatalog(state);
}

export function observeProjects(state,profileId,snapshot,event=null){
  const profile=state.profiles[profileId];if(!profile)throw Error('Неизвестный профиль');
  const projects=Object.values(snapshot).filter(local);
  for(const p of projects)if(!validProject(p))throw Error('Неполный ответ сервиса проектов');
  for(const op of [...state.operations])if(op.profile===profileId&&op.type==='remove'&&!snapshot[op.desktopId])acknowledge(state,op,{removed:true});
  const explicitRemoved=new Set(event?.method==='removeLocal'?Object.keys(event.before??{}).filter(id=>!event.after?.[id]):[]);
  const bindingByDesktop=new Map(Object.entries(profile.bindings).map(([id,b])=>[b.desktopId,{id,b}]));
  for(const desktopId of explicitRemoved){
    const found=bindingByDesktop.get(desktopId);if(!found)continue;
    const p=state.projects[found.id];p.deleted=true;found.b.lastSeen=null;found.b.missing=false;
    state.conflicts=state.conflicts.filter(c=>!(c.kind==='missing'&&c.projectId===p.id&&c.profile===profileId));
  }
  for(const p of projects){
    let found=bindingByDesktop.get(p.id);
    if(!found){
      // Rebind an ID migrated by the application only when its old counterpart disappeared.
      const matches=Object.values(state.projects).filter(q=>!q.deleted&&identity(q)===identity(p));
      const free=matches.filter(q=>!profile.bindings[q.id]||(!snapshot[profile.bindings[q.id].desktopId]&&!profile.bindings[q.id].known));
      const migrated=event?[]:matches.filter(q=>profile.bindings[q.id]?.known&&!snapshot[profile.bindings[q.id].desktopId]);
      let shared=free.length===1?free[0]:migrated.length===1?migrated[0]:null;
      if(!shared){shared={id:randomUUID(),...fields(p)};state.projects[shared.id]=shared;state.projectOrder.push(shared.id);}
      const b=profile.bindings[shared.id]={desktopId:p.id,lastSeen:fields(p),known:true};found={id:shared.id,b};bindingByDesktop.set(p.id,found);
      state.conflicts=state.conflicts.filter(c=>!(c.kind==='missing'&&c.projectId===shared.id&&c.profile===profileId));
      if(shared.name!==p.name)conflict(state,{kind:'field',projectId:shared.id,profile:profileId,field:'name',baseValue:shared.name,sharedValue:shared.name,localValue:p.name});
    }
    const shared=state.projects[found.id],binding=found.b,observed=fields(p);
    const pending=state.operations.find(o=>o.profile===profileId&&o.projectId===shared.id&&o.type==='upsert');
    if(pending&&equal(observed,pending.value)){binding.lastSeen=observed;binding.known=true;binding.missing=false;state.operations=state.operations.filter(o=>o.id!==pending.id);continue;}
    if(shared.deleted){
      const restored=event&&['upsertLocal','createLocal'].includes(event.method)&&!event.before?.[p.id];
      if(restored){delete shared.deleted;Object.assign(shared,observed);}else continue;
    }
    if(binding.lastSeen!==null){
      for(const key of ['name','rootPaths']){
        if(equal(observed[key],binding.lastSeen[key]))continue;
        if(equal(shared[key],binding.lastSeen[key])||equal(shared[key],observed[key]))shared[key]=clone(observed[key]);
        else conflict(state,{kind:'field',projectId:shared.id,profile:profileId,field:key,baseValue:clone(binding.lastSeen[key]),sharedValue:clone(shared[key]),localValue:clone(observed[key])});
      }
    }
    binding.lastSeen=observed;binding.known=true;binding.missing=false;
    state.conflicts=state.conflicts.filter(c=>!(c.kind==='missing'&&c.projectId===shared.id&&c.profile===profileId));
  }
  for(const [id,b]of Object.entries(profile.bindings)){
    if(!b.known||snapshot[b.desktopId]||state.projects[id].deleted||state.projects[id].cleanupHold||b.lastSeen===null)continue;
    b.missing=true;
    conflict(state,{kind:'missing',projectId:id,profile:profileId,field:'presence',sharedValue:true,localValue:false});
  }
  if(event?.method==='setProjectOrder'&&Array.isArray(event.args?.[0])){
    const ids=event.args[0].map(native=>bindingByDesktop.get(native)?.id).filter(Boolean);
    if(ids.length){const included=new Set(ids),old=state.projectOrder;let i=0;state.projectOrder=old.map(id=>included.has(id)?ids[i++]:id);for(const id of ids)if(!state.projectOrder.includes(id))state.projectOrder.push(id);}
  }
  ensureBindings(state);return state;
}

export function planOperation(state,profileId,snapshot){
  const profile=state.profiles[profileId];
  if(profile.pauseReason)return null;
  state.operations=state.operations.filter(op=>{if(op.profile!==profileId||op.startedAt)return true;const p=state.projects[op.projectId],b=profile.bindings[op.projectId],actual=snapshot[b.desktopId];return p.deleted?op.type==='remove'&&!!actual:op.type==='upsert'&&equal(op.value,fields(p))&&(!actual||!equal(fields(actual),fields(p)));});
  const started=state.operations.find(op=>op.profile===profileId&&op.startedAt);
  if(started)return clone(started);
  for(const id of state.projectOrder){
    const p=state.projects[id],b=profile.bindings[id];if(!b||p.cleanupHold||b.registrationBlock||state.conflicts.some(c=>c.projectId===id))continue;
    const actual=snapshot[b.desktopId];
    // A tool-created project first uses the originating profile's native Trust flow.
    // Other profiles wait for that actual registration before provenance-based restore.
    if(!actual&&p.registrationSource&&p.registrationSource!==profileId){
      const source=state.profiles[p.registrationSource]?.bindings[id];
      if(!source?.known||source.missing||!source.lastSeen||!equal(source.lastSeen.rootPaths.map(rootKey),p.rootPaths.map(rootKey)))continue;
    }
    if(p.deleted&&!actual)continue;
    if(!p.deleted&&actual&&equal(fields(actual),fields(p)))continue;
    if(!p.deleted&&b.missing)continue;
    const type=p.deleted?'remove':'upsert',value=p.deleted?null:fields(p);
    let op=state.operations.find(o=>o.profile===profileId&&o.projectId===id);
    if(!op||op.type!==type||!equal(op.value,value)){
      state.operations=state.operations.filter(o=>!(o.profile===profileId&&o.projectId===id));
      op={id:randomUUID(),profile:profileId,projectId:id,desktopId:b.desktopId,type,value,expected:actual?fields(actual):null,createdAt:new Date().toISOString()};state.operations.push(op);
    }
    op.expected=actual?fields(actual):null;
    // A native project in another account is the provenance for this same local
    // directory registration. Manual catalogue edits alone grant no such consent.
    const approvedBy=!actual&&!p.deleted?Object.entries(state.profiles).find(([other,q])=>{
      const source=q.bindings[id];return other!==profileId&&source?.known&&!source.missing&&source.lastSeen&&
        equal(source.lastSeen.rootPaths.map(rootKey),p.rootPaths.map(rootKey));
    })?.[0]:null;
    op.registration=approvedBy?'restore':'sync';op.approvedBy=approvedBy??null;
    return clone(op);
  }
  return null;
}
export function acknowledge(state,operation,result){
  const op=state.operations.find(o=>o.id===operation.id);if(!op)return;
  const b=state.profiles[op.profile].bindings[op.projectId];
  b.lastSeen=op.type==='remove'?null:fields(result);b.known=op.type!=='remove';b.missing=false;
  if(result.trust)b.trust=clone(result.trust);
  delete b.registrationBlock;
  state.operations=state.operations.filter(o=>o.id!==op.id);
}
export function markStarted(state,id){
  const op=state.operations.find(o=>o.id===id);if(!op)return null;
  op.startedAt??=new Date().toISOString();return clone(op);
}
export function failOperation(state,id,error,{pause=false,registrationBlock=null}={}){
  const op=state.operations.find(o=>o.id===id);if(!op)return;
  state.operations=state.operations.filter(o=>o.id!==id);
  if(pause)state.profiles[op.profile].pauseReason=String(error);
  if(registrationBlock)state.profiles[op.profile].bindings[op.projectId].registrationBlock={status:registrationBlock,error:String(error)};
}
export function resumeSync(state){for(const p of Object.values(state.profiles)){delete p.pauseReason;for(const b of Object.values(p.bindings))delete b.registrationBlock;}}
export function pendingCount(state,profileId){
  let count=0;
  for(const p of Object.values(state.projects)){
    const b=state.profiles[profileId].bindings[p.id];if(!b)continue;
    if(p.deleted?b.lastSeen!==null:!equal(b.lastSeen,fields(p)))count++;
  }
  return count;
}
export function resolveConflict(state,id,choice){
  const c=state.conflicts.find(c=>c.id===id);if(!c||!['shared','local'].includes(choice))throw Error('Конфликт или решение не найдены');
  if(state.operations.some(o=>o.projectId===c.projectId&&o.startedAt))throw Error('Сначала завершите ожидающую операцию в приложении');
  const p=state.projects[c.projectId],b=state.profiles[c.profile].bindings[c.projectId];
  if(c.kind==='missing'){
    if(choice==='local')p.deleted=true;
    else {b.lastSeen=null;b.known=false;b.missing=false;}
  }else if(c.kind==='folder'){
    const target=choice==='local'?c.localValue:c.sharedValue;if(target)state.projectFolderMap[p.id]=target;else delete state.projectFolderMap[p.id];
  }else p[c.field]=clone(choice==='local'?c.localValue:c.sharedValue);
  state.conflicts=state.conflicts.filter(other=>other.projectId!==c.projectId||other.field!==c.field);
  state.operations=state.operations.filter(o=>o.projectId!==c.projectId);
}
export function folderOperation(state,profileId,operation){
  if(operation.type==='resolve-conflict'){resolveConflict(state,operation.id,operation.choice);return;}
  const profile=state.profiles[profileId];const op={...operation};
  if(op.type==='assign')op.projectKey=logicalForNative(state,profileId,op.projectKey);
  const next=applyOperation({schemaVersion:1,revision:state.revision,folders:state.folders,projectFolderMap:state.projectFolderMap,collapsedFolderIds:profile.collapsedFolderIds},op);
  state.folders=next.folders;state.projectFolderMap=next.projectFolderMap;profile.collapsedFolderIds=next.collapsedFolderIds;
  for(const p of Object.values(state.profiles))p.collapsedFolderIds=p.collapsedFolderIds.filter(id=>state.folders.some(f=>f.id===id));
}

// The native createLocal result supplies the exact ID; no name or DOM-order matching.
export function assignCreatedProject(state,profileId,snapshot,projectId,folderId){
  if(!state.profiles[profileId]||!state.folders.some(f=>f.id===folderId))throw Error('Папка уже удалена');
  if(!snapshot[projectId]||!local(snapshot[projectId]))throw Error('Созданный местный проект не найден');
  observeProjects(state,profileId,snapshot);
  folderOperation(state,profileId,{type:'assign',projectKey:nativeKey(projectId),folderId});
  const ancestors=new Set();let folder=state.folders.find(f=>f.id===folderId);
  while(folder){ancestors.add(folder.id);folder=state.folders.find(f=>f.id===folder.parentId);}
  state.profiles[profileId].collapsedFolderIds=state.profiles[profileId].collapsedFolderIds.filter(id=>!ancestors.has(id));
}

// Idempotent integration boundary for local project producers (for example Upwork).
// The daemon owns this transaction; callers never edit catalog.json or profile files.
export function selectRegistrationSources(state,availableProfiles){
  const available=availableProfiles.filter(id=>state.profiles[id]);
  if(!available.length)return;
  for(const project of Object.values(state.projects)){
    if(project.deleted||!project.trustPolicy||!project.registrationSource||available.includes(project.registrationSource))continue;
    if(state.operations.some(op=>op.projectId===project.id&&op.startedAt))continue;
    const registered=Object.values(state.profiles).some(p=>{const b=p.bindings[project.id];return b?.known&&!b.missing&&b.lastSeen&&identity(b.lastSeen)===identity(project);});
    if(!registered)project.registrationSource=available[0];
  }
}

export function ensureProject(state,profileId,spec,{availableProfiles=[]}={}){
  if(!state.profiles[profileId])throw Error('Неизвестный исходный профиль');
  if(!spec||!validProject({id:'validation',...spec})||!Array.isArray(spec.folderPath)||
    !spec.folderPath.length||spec.folderPath.some(name=>typeof name!=='string'||!name.trim()||name.length>160))throw Error('Некорректный запрос регистрации проекта');
  if(spec.trustPolicy!==undefined&&spec.trustPolicy!=='upwork-daily')throw Error('Неизвестная политика доверия проекта');
  const matches=Object.values(state.projects).filter(p=>!p.deleted&&identity(p)===identity(spec));
  if(matches.length>1)throw Error('Неоднозначное сопоставление рабочих каталогов проекта');
  let project=matches[0];
  if(project&&state.conflicts.some(c=>c.projectId===project.id))throw Error('Сначала разрешите конфликт общего проекта');
  if(!project){
    project={id:randomUUID(),...fields(spec),registrationSource:profileId};
    state.projects[project.id]=project;state.projectOrder.push(project.id);ensureBindings(state);
  }
  if(spec.trustPolicy)project.trustPolicy=spec.trustPolicy;
  selectRegistrationSources(state,availableProfiles);
  let parentId=null;
  for(const name of spec.folderPath){
    const matches=state.folders.filter(f=>f.parentId===parentId&&f.name.normalize('NFKC').toLocaleLowerCase('en-US')===name.normalize('NFKC').toLocaleLowerCase('en-US'));
    if(matches.length>1)throw Error('Неоднозначная ветка папок');
    let folder=matches[0];
    if(!folder){folder={id:randomUUID(),name,parentId};folderOperation(state,profileId,{type:'create',...folder});}
    parentId=folder.id;
  }
  folderOperation(state,profileId,{type:'assign',projectKey:'shared:'+project.id,folderId:parentId});
  return registrationReceipt(state,project.id,profileId);
}

export function registrationReceipt(state,id,profileId){
  const project=state.projects[id];
  if(!project||project.deleted||!state.profiles[profileId])throw Error('Общий проект или профиль не найден');
  const folderId=state.projectFolderMap[id],branch=[];let folder=state.folders.find(f=>f.id===folderId);
  while(folder){branch.unshift(folder.name);folder=state.folders.find(f=>f.id===folder.parentId);}
  const profiles=Object.fromEntries(Object.entries(state.profiles).map(([name,p])=>{
    const binding=p.bindings[id],ready=!!(binding?.known&&!binding.missing&&equal(binding.lastSeen,fields(project)));
    return [name,{project_id:binding?.desktopId??null,ready,pause_reason:p.pauseReason??null,
      registration_block:binding?.registrationBlock??null,trust:binding?.trust??null}];
  }));
  return {shared_id:id,project_name:project.name,root_paths:[...project.rootPaths],folder_id:folderId,
    folder_path:branch.join(' / '),profiles,complete:profiles[profileId].ready,
    status:profiles[profileId].ready?'registered':profiles[profileId].registration_block?.status??'pending',
    registration_source:project.registrationSource??null,trust_policy:project.trustPolicy??null,
    conflicts:state.conflicts.filter(c=>c.projectId===id)};
}
export function projectState(state,profileId,status={}){
  const profile=state.profiles[profileId],map={},order=[];
  for(const id of state.projectOrder){
    const p=state.projects[id],b=profile.bindings[id];if(!b||p.deleted)continue;
    for(const key of [nativeKey(b.desktopId),'codex:project:'+b.desktopId,'local:'+b.desktopId,'codex:'+b.desktopId]){
      if(state.projectFolderMap[id])map[key]=state.projectFolderMap[id];
      order.push(key);
    }
  }
  return {schemaVersion:1,revision:state.revision,folders:clone(state.folders),projectFolderMap:map,collapsedFolderIds:clone(profile.collapsedFolderIds),projectOrder:order,
    sync:{...status,shared:true,conflicts:state.conflicts.map(c=>({...c,projectName:state.projects[c.projectId]?.name})),profiles:Object.keys(state.profiles).map(id=>({id,pending:pendingCount(state,id)}))}};
}

async function readSeeds(profiles){
  return Promise.all(profiles.map(async profile=>{
    const global=JSON.parse(await fs.readFile(path.join(profile.home,'.codex-global-state.json'),'utf8'));
    let folders;try{folders=JSON.parse(await fs.readFile(path.join(profile.home,'ui-folders.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;folders=emptyState();}
    return {id:profile.id,projects:global['local-projects']??{},order:global['project-order']??[],folders};
  }));
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class CatalogStore{
  constructor(file=catalogFile){this.file=file;this.state=null;this.queue=Promise.resolve();}
  async load(profiles){
    try{this.state=validateCatalog(JSON.parse(await fs.readFile(this.file,'utf8')));}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      const seeds=await readSeeds(profiles),state=migrateSeeds(seeds);
      const backup=path.join(path.dirname(this.file),'backups','migration-'+new Date().toISOString().replace(/[:.]/g,'-'));
      await backupProfiles(profiles,backup);
      if(digest(seeds)!==digest(await readSeeds(profiles)))throw Error('Проекты или папки изменились во время подготовки миграции. Повторите запуск помощника.');
      state.migration.backup=backup;state.migration.inputDigest=digest(seeds);
      await this.write(state,false);this.state=state;
      await fs.writeFile(path.join(backup,'migration-plan.json'),JSON.stringify({projects:Object.values(state.projects).map(p=>({name:p.name,rootPaths:p.rootPaths,profiles:Object.fromEntries(Object.entries(state.profiles).map(([id,q])=>[id,q.bindings[p.id]]))})),folders:state.folders},null,2)+'\n');
    }
    return clone(this.state);
  }
  async write(state,backup=true){
    validateCatalog(state);await fs.mkdir(path.dirname(this.file),{recursive:true});
    if(backup&&this.state)await fs.writeFile(this.file+'.bak',JSON.stringify(this.state,null,2)+'\n');
    const temp=this.file+'.'+process.pid+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');await fs.rename(temp,this.file);}finally{await fs.rm(temp,{force:true});}
  }
  transact(action){
    const work=this.queue.then(async()=>{
      const current=validateCatalog(JSON.parse(await fs.readFile(this.file,'utf8'))),next=clone(current);
      const result=await action(next);
      if(!equal(current,next)){next.revision=current.revision+1;this.state=current;await this.write(next);this.state=next;}else this.state=current;
      return {state:clone(this.state),result};
    });this.queue=work.catch(()=>{});return work;
  }
}
