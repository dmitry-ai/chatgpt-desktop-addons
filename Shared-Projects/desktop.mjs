import {ensureTrustedRoots} from './trust.mjs';

// Browser-side project capability discovery. No installation files or credentials are read.
export function findProjectServiceExport(source) {
  const candidates = [];
  const pattern = /function\s+([\w$]+)\(\)\{let\s+([\w$]+)=([\w$]+)\.projects;if\(\2==null\)throw Error\([^)]*\);return \2\}/g;
  for (const match of source.matchAll(pattern)) {
    for (const exports of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const entry of exports[1].split(',')) {
        const parts = entry.trim().split(/\s+as\s+/);
        if (parts[0] === match[1]) candidates.push(parts[1] ?? parts[0]);
      }
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw Error('Не найден однозначный сервис проектов Desktop App');
  return unique[0];
}

export function findProjectHostImport(source) {
  const getter = /function\s+([\w$]+)\(\)\{let\s+([\w$]+)=([\w$]+)\.projects;if\(\2==null\)throw Error\([^)]*\);return \2\}/.exec(source);
  if (!getter) throw Error('Project service getter is missing');
  const variable = getter[3];
  const matches = [];
  for (const declaration of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"`])([^'"`]+)\2/g)) {
    for (const entry of declaration[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/);
      if ((parts[1] ?? parts[0]) === variable) matches.push({name:parts[0],url:declaration[3]});
    }
  }
  if (matches.length !== 1) throw Error('Project host binding is ambiguous');
  return matches[0];
}

export function findMessageBusImport(source){
  const names=[...new Set([...source.matchAll(/([\w$]+)\.subscribe\([`'"]shared-object-updated[`'"]/g)].map(m=>m[1]))];
  if(names.length!==1||!source.includes(names[0]+'.dispatchMessage('))throw Error('Desktop message bus is ambiguous');
  const matches=[];
  for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"`])([^'"`]+)\2/g))for(const entry of m[1].split(',')){
    const parts=entry.trim().split(/\s+as\s+/);
    if((parts[1]??parts[0])===names[0])matches.push({name:parts[0],url:m[3]});
  }
  if(matches.length!==1)throw Error('Desktop message bus import is ambiguous');
  return matches[0];
}

export function configRequest(bus,method,params){
  if(!['config/read','config/batchWrite'].includes(method))throw Error('Unsupported shared-project config method');
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();let timer,off=()=>{};
    const finish=(error,result)=>{clearTimeout(timer);off();error?reject(error):resolve(result);};
    try{
      off=bus.subscribe('mcp-response',event=>{
        if(event.hostId!=='local'||event.message?.id!==id)return;
        event.message.error?finish(Error(event.message.error.message)):finish(null,event.message.result);
      });
      timer=setTimeout(()=>finish(Error('TRUST_TIMEOUT: результат конфигурационного запроса не получен')),15000);
      bus.dispatchMessage('mcp-request',{hostId:'local',request:{id,method,params},priority:'interactive',source:'config',timeoutMs:15000});
    }catch(error){finish(error);}
  });
}

// A native folder confirmation may remain open indefinitely. Keep its one promise
// in the renderer instead of submitting another RPC after a CDP timeout.
export function operationLedger(tasks, execute, changed) {
  const state = task => task.state === 'done' ? {state:'done',result:task.result}
    : task.state === 'failed' ? {state:'failed',error:task.error} : {state:'pending'};
  return {
    start(operation,allowStart=true) {
      const key=JSON.stringify([operation.type,operation.desktopId,operation.value,operation.expected,operation.registration,operation.approvedBy,operation.trust]);
      const previous=tasks.get(operation.id);
      if(previous){if(previous.key!==key)throw Error('Operation ID was reused with different data');return state(previous);}
      if(!allowStart)return {state:'blocked'};
      const task={key,state:'pending'};tasks.set(operation.id,task);
      Promise.resolve().then(()=>execute(operation)).then(result=>Object.assign(task,{state:'done',result}),
        error=>Object.assign(task,{state:'failed',error:String(error?.message??error)})).finally(()=>{
          try{changed();}catch{}
        });
      return state(task);
    },
    forget(id){if(tasks.get(id)?.state!=='pending')tasks.delete(id);},
    retain(ids){const keep=new Set(ids);for(const [id,task]of tasks)if(task.state!=='pending'&&!keep.has(id))tasks.delete(id);}
  };
}

async function connectDesktop(findExport, findHost, makeLedger,findBus,requestConfig,ensureTrust) {
  if (window.__codexSharedDesktop?.version === 8) return window.__codexSharedDesktop.info;
  let urls = [...new Set([
    ...performance.getEntriesByType('resource').map(e => e.name),
    ...[...document.scripts].map(e => e.src)
  ])].filter(url => /^app:\/\/-\/assets\/app-initial-[\w-]+\.js$/.test(url));
  if (!urls.length) {
    const found = new Set();
    for (const script of document.scripts) {
      if (!/^app:\/\/-\/assets\/index-[\w-]+\.js$/.test(script.src)) continue;
      const entry = await (await fetch(script.src)).text();
      for (const match of entry.matchAll(/app-initial-[\w-]+\.js/g)) found.add(new URL('./'+match[0], script.src).href);
    }
    urls = [...found];
  }
  if (urls.length !== 1) throw Error('Основной модуль Desktop App не найден или неоднозначен');
  const url = urls[0];
  const response = await fetch(url);
  if (!response.ok) throw Error('Не удалось прочитать модуль Desktop App');
  const source = await response.text();
  if (!source.includes('.upsertLocal(') || !source.includes('.editLocal(') || !source.includes('.setProjectOrder(')) {
    throw Error('Изменился контракт проектов Desktop App; синхронизация остановлена');
  }
  if (!/\.upsertLocal\([\s\S]{0,600}?,[`'"]restore[`'"]\)/.test(source)) {
    throw Error('Режим восстановления проектов Desktop App не подтверждён; синхронизация остановлена');
  }
  const name = findExport(source);
  const module = await import(url);
  const binding = findHost(source);
  const host = (await import(new URL(binding.url,url).href))[binding.name];
  if (!host?.projects) throw Error('DESKTOP_STARTING: сервис проектов ещё инициализируется');
  const projects = module[name]();
  const busBinding=findBus(source);
  const bus=(await import(new URL(busBinding.url,url).href))[busBinding.name];
  if(typeof bus?.subscribe!=='function'||typeof bus?.dispatchMessage!=='function')throw Error('Desktop config connection is unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(host,'projects');
  if (host.projects !== projects || !descriptor?.writable) throw Error('Desktop project capability cannot be safely observed');
  const read = async () => {
    const value = await projects.getLocalProjects();
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Некорректный список проектов Desktop App');
    for (const [id, item] of Object.entries(value)) {
      if (!item || item.id !== id || typeof item.name !== 'string' || !Array.isArray(item.rootPaths) ||
          item.rootPaths.some(p => typeof p !== 'string' || !p)) throw Error('Изменился формат проекта Desktop App');
    }
    return value;
  };
  const clean = values => Object.fromEntries(Object.entries(values).map(([id,p]) => [id,{
    id, name:p.name, rootPaths:p.rootPaths,
    cloudBacked:!!(p.chatGptBacking || p.chatGptBackingCreation || p.retiredChatGptBacking)
  }]));
  const events = [];
  const creationListeners = new Set();
  const methods = new Set(['createLocal','editLocal','renameLocal','upsertLocal','removeLocal','setProjectOrder']);
  const wrappers = new Map();
  const proxy = new Proxy(projects, {get(target,key) {
    const original = target[key];
    if (!methods.has(key) || typeof original !== 'function') return original;
    if (!wrappers.has(key)) wrappers.set(key,async(...args) => {
      // Capture the originating dialog before the native async operation starts.
      const created = key === 'createLocal' ? [...creationListeners].map(listener => listener()).filter(Boolean) : [];
      let before; try { before = clean(await read()); } catch {}
      const result = await Reflect.apply(original,target,args);
      let after; try { after = clean(await read()); } catch {}
      if (before && after) {
        events.push({id:crypto.randomUUID(),method:key,args,before,after});
        if (events.length > 100) { events.splice(0,events.length-100); events.push({method:'overflow'}); }
        try { window.__codexSharedChanged?.(JSON.stringify({event:'projects'})); } catch {}
      }
      if (result?.projectId) for (const listener of created) {
        try { await listener(result.projectId); } catch (error) { console.warn('[codex-folders] Project placement:', error); }
      }
      return result;
    });
    return wrappers.get(key);
  }});
  const snapshot = clean(await read());
  window.__codexSharedDesktop?.dispose?.();
  host.projects = proxy;
  const info = {url, exportName:name, appVersion:window.electronBridge?.getSentryInitOptions?.().appVersion ?? null};
  const api = window.__codexSharedDesktop = {
    version:8, info, read:async()=>clean(await read()),
    onLocalProjectCreating(listener){creationListeners.add(listener);return()=>creationListeners.delete(listener)},
    drainEvents(){return events.splice(0)},
    dispose(){creationListeners.clear();if(host.projects===proxy)host.projects=projects;delete window.__codexSharedDesktop},
    async upsert(item, expected, registration='sync',trust=null) {
      if(!['sync','restore'].includes(registration))throw Error('Неизвестный режим регистрации проекта');
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' ||
          !item.name.trim() || !Array.isArray(item.rootPaths) || !item.rootPaths.length) throw Error('Некорректная операция проекта');
      const before = await read();
      const existing = before[item.id];
      const fields = p => p ? JSON.stringify([p.name,p.rootPaths]) : null;
      if (expected !== undefined && fields(existing) !== fields(expected)) throw Error('PROJECT_CHANGED: проект изменён до применения операции');
      if (existing?.chatGptBacking || existing?.chatGptBackingCreation || existing?.retiredChatGptBacking) {
        throw Error('Облачные проекты ChatGPT не синхронизируются этим модулем');
      }
      if(trust&&JSON.stringify(trust.roots)!==JSON.stringify(item.rootPaths))throw Error('TRUST_POLICY: корни операции не совпали');
      const verified=trust?await ensureTrust((method,params)=>requestConfig(bus,method,params),trust):null;
      const checked=(await read())[item.id];
      if(fields(checked)!==fields(existing))throw Error('PROJECT_CHANGED: проект изменён во время проверки доверия');
      if(checked?.chatGptBacking||checked?.chatGptBackingCreation||checked?.retiredChatGptBacking)throw Error('PROJECT_CHANGED: проект стал облачным');
      const ok = await projects.upsertLocal({projectId:item.id,name:item.name,sources:item.rootPaths}, registration);
      if (ok !== true) throw Error('Приложение не подтвердило сохранение проекта');
      const after = await read();
      if (!after[item.id]) throw Error('Проект не появился после сохранения');
      return {...clean(after)[item.id],...(verified?{trust:verified}:{})};
    },
    async remove(id,expected) {
      const before = await read();const existing=before[id];
      if (!existing) return {removed:true};
      if (JSON.stringify([existing.name,existing.rootPaths]) !== JSON.stringify([expected.name,expected.rootPaths])) throw Error('PROJECT_CHANGED: проект изменён перед удалением');
      if (existing.chatGptBacking || existing.chatGptBackingCreation || existing.retiredChatGptBacking) throw Error('Удаление облачного проекта не поддерживается');
      await projects.removeLocal(id);
      if ((await read())[id]) throw Error('Приложение не подтвердило удаление проекта');
      return {removed:true};
    }
  };
  const tasks=window.__codexSharedTasks??=new Map();
  const ledger=makeLedger(tasks,op=>op.type==='upsert'?api.upsert({id:op.desktopId,...op.value},op.expected,
    op.registration==='restore'&&typeof op.approvedBy==='string'?'restore':'sync',op.trust):api.remove(op.desktopId,op.expected),
    ()=>window.__codexSharedChanged?.(JSON.stringify({event:'operation'})));
  api.startOperation=(operation,allowStart)=>ledger.start(operation,allowStart);
  api.forgetOperation=id=>ledger.forget(id);
  api.retainOperations=ids=>ledger.retain(ids);
  return {...info, snapshot};
}

export const connectScript = () => '(' + connectDesktop.toString() + ')(' + [findProjectServiceExport,findProjectHostImport,operationLedger,findMessageBusImport,configRequest,ensureTrustedRoots].map(fn=>fn.toString()).join(',')+')';
