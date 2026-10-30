// Explicit, interactive cancellation check. It submits exactly one native request.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CDP} from '../UI/cdp.mjs';
import {profiles} from '../UI/paths.mjs';
import {stateDirectory} from './catalog.mjs';
const command=process.argv[2]??'status';
if(!['start','status','forget'].includes(command))throw Error('Expected start, status or forget');
const profile=profiles.find(p=>p.id==='C1');
const targets=await(await fetch('http://127.0.0.1:'+profile.port+'/json/list')).json();
const target=targets.find(t=>t.type==='page'&&t.url==='app://-/index.html');
if(!target)throw Error('C1 window unavailable');
const c=await CDP.open(target.webSocketDebuggerUrl);
try{
  const item={id:randomUUID(),name:'Shared Projects — отмена '+randomUUID().slice(0,8),rootPaths:[path.join(stateDirectory,'integration-workspace')]};
  const result=await c.evaluate('('+function(command,item){
    const previous=window.__codexSharedCancelCheck;
    if(command==='status')return previous??null;
    if(command==='forget'){
      if(previous?.state==='pending')throw Error('Native confirmation is still pending');
      delete window.__codexSharedCancelCheck;return {forgotten:true};
    }
    if(previous)return previous;
    const task=window.__codexSharedCancelCheck={id:item.id,name:item.name,rootPaths:item.rootPaths,state:'pending',startedAt:new Date().toISOString()};
    window.__codexSharedDesktop.upsert(item,null).then(result=>Object.assign(task,{state:'accepted',result}),
      error=>Object.assign(task,{state:'declined',error:String(error?.message??error)}));
    return task;
  }.toString()+')('+JSON.stringify(command)+','+JSON.stringify(item)+')');
  if(result&&command!=='forget')await fs.writeFile(path.join(stateDirectory,'verification-cancel.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{c.close();}
