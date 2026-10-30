import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {CDP} from '../UI/cdp.mjs';
import {profiles} from '../UI/paths.mjs';
import {connectScript} from './desktop.mjs';
const smoke=process.argv.includes('--smoke');
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'state','smoke-workspace');
if(smoke)await fs.mkdir(fixture,{recursive:true});
for(const profile of profiles){
  const targets=await(await fetch('http://127.0.0.1:'+profile.port+'/json/list')).json();
  const target=targets.find(t=>t.type==='page'&&t.url.startsWith('app://-/index.html')&&!/prewarm=1|avatar-overlay|hotkey/.test(t.url));
  if(!target){console.log(profile.id,'closed');continue;}
  const cdp=await CDP.open(target.webSocketDebuggerUrl);
  try{
    await cdp.call('Runtime.enable');
    const info=await cdp.evaluate(connectScript());
    const before=await cdp.evaluate('window.__codexSharedDesktop.read()');
    if(smoke){
      const id=randomUUID();
      const expression='(async()=>{const api=window.__codexSharedDesktop;const module=await import(api.info.url);const service=module[api.info.exportName]();const id='+JSON.stringify(id)+';try{await service.upsertLocal({projectId:id,name:"Shared Projects — проверка",sources:['+JSON.stringify(fixture)+']},"sync");await service.upsertLocal({projectId:id,name:"Shared Projects — проверка",sources:['+JSON.stringify(fixture)+']},"sync");await service.renameLocal({projectId:id,name:"Shared Projects — повтор"});return {created:(await api.read())[id],events:api.drainEvents().map(e=>e.method)};}finally{if((await api.read())[id])await service.removeLocal(id);}})()';
      const result=await cdp.evaluate(expression,60000);
      const after=await cdp.evaluate('window.__codexSharedDesktop.read()');
      if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Existing projects changed during smoke check');
      console.log(JSON.stringify({profile:profile.id,appVersion:info.appVersion,smoke:result,existingProjectsPreserved:true}));
      await cdp.evaluate('window.__codexSharedDesktop?.dispose()');
    }else console.log(JSON.stringify({profile:profile.id,appVersion:info.appVersion,exportName:info.exportName,projects:Object.values(before).map(p=>({id:p.id,name:p.name,rootPaths:p.rootPaths}))},null,2));
  }finally{cdp.close();}
}