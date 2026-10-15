import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyState = () => ({schemaVersion:1, revision:0, folders:[], projectFolderMap:{}, collapsedFolderIds:[]});
const sameName = name => name.normalize('NFKC').toLocaleLowerCase('en-US');
export function validate(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.folders) || !state.projectFolderMap || Array.isArray(state.projectFolderMap) ||
      typeof state.projectFolderMap !== 'object' || !Array.isArray(state.collapsedFolderIds)) throw Error('Некорректный формат ui-folders.json');
  const ids = new Map(); const names = new Set();
  for (const folder of state.folders) {
    if (typeof folder.id !== 'string' || !folder.id || ids.has(folder.id) ||
        typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 160 ||
        (folder.parentId !== null && typeof folder.parentId !== 'string')) throw Error('Некорректная папка');
    const key = JSON.stringify([folder.parentId, sameName(folder.name.trim())]);
    if (names.has(key)) throw Error('Папка с таким именем уже есть в этом расположении');
    ids.set(folder.id, folder); names.add(key);
  }
  for (const folder of state.folders) {
    const visited = new Set([folder.id]); let id = folder.parentId;
    while (id !== null) {
      if (!ids.has(id)) throw Error('Родительская папка не найдена');
      if (visited.has(id)) throw Error('Нельзя переместить папку в себя или свою подпапку');
      visited.add(id); id = ids.get(id).parentId;
    }
  }
  for (const [key,id] of Object.entries(state.projectFolderMap)) {
    if (!key || typeof id !== 'string' || !ids.has(id)) throw Error('Некорректная привязка проекта');
  }
  if (state.collapsedFolderIds.some(id => !ids.has(id))) throw Error('Некорректное состояние раскрытия папок');
  return state;
}

export function applyOperation(previous, operation) {
  const state = structuredClone(validate(previous));
  const folder = () => {const value=state.folders.find(f=>f.id===operation.id);if(!value)throw Error('Папка уже удалена');return value};
  switch (operation.type) {
    case 'create': state.folders.push({id:operation.id??randomUUID(), name:String(operation.name??'').trim(), parentId:operation.parentId??null}); break;
    case 'rename': folder().name=String(operation.name??'').trim(); break;
    case 'edit': {const f=folder();f.name=String(operation.name??'').trim();f.parentId=operation.parentId??null;break;}
    case 'move': folder().parentId=operation.parentId??null; break;
    case 'remove': {
      const value=folder();
      state.folders=state.folders.filter(f=>f.id!==value.id).map(f=>f.parentId===value.id?{...f,parentId:value.parentId}:f);
      for (const [key,id] of Object.entries(state.projectFolderMap)) if(id===value.id) {
        if(value.parentId===null) delete state.projectFolderMap[key]; else state.projectFolderMap[key]=value.parentId;
      }
      state.collapsedFolderIds=state.collapsedFolderIds.filter(id=>id!==value.id); break;
    }
    case 'assign': {
      if(typeof operation.projectKey!=='string' || !operation.projectKey || operation.projectKey.length>700)throw Error('Не указан проект');
      if(operation.folderId==null)delete state.projectFolderMap[operation.projectKey];
      else state.projectFolderMap[operation.projectKey]=operation.folderId;
      break;
    }
    case 'collapse': {
      folder(); const ids=new Set(state.collapsedFolderIds);
      operation.collapsed?ids.add(operation.id):ids.delete(operation.id);
      state.collapsedFolderIds=[...ids]; break;
    }
    default: throw Error('Неизвестная операция с папками');
  }
  state.revision++; return validate(state);
}

export class FolderStore {
  constructor(file) {this.file=file;this.state=null;this.queue=Promise.resolve()}
  async load() {
    try {this.state=validate(JSON.parse(await fs.readFile(this.file,'utf8')))}
    catch(error) {if(error.code!=='ENOENT')throw error;this.state=emptyState();await this.write(this.state,false)}
    return structuredClone(this.state);
  }
  async write(state, backup=true) {
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    if(backup && this.state)await fs.writeFile(this.file+'.bak',JSON.stringify(this.state,null,2)+'\n');
    const temp=this.file+'.'+process.pid+'.tmp';
    try {await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{flag:'w'});await fs.rename(temp,this.file)}
    finally {await fs.rm(temp,{force:true})}
  }
  operate(operation) {
    const work=this.queue.then(async()=>{
      // Read again inside the queue so edits committed by another window are retained.
      const latest=validate(JSON.parse(await fs.readFile(this.file,'utf8')));
      const next=applyOperation(latest,operation);this.state=latest;
      await this.write(next);this.state=next;return structuredClone(next);
    });
    this.queue=work.catch(()=>{});return work;
  }
  reload() {
    const work=this.queue.then(()=>this.load());this.queue=work.catch(()=>{});return work;
  }
}
