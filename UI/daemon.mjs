import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FolderStore } from '../../Folders/code/store.mjs';
import { CDP } from './cdp.mjs';
import { profiles,pipeName } from './paths.mjs';

const code=path.dirname(fileURLToPath(import.meta.url));
const rendererFile=path.resolve(code,'../../Folders/code/renderer.js');
const cssFile=path.resolve(code,'../../CSS/code/style.css');
const logFile=path.join(code,'ui.log');
const stores=new Map(),clients=new Map(),connecting=new Set(),watchers=[];
let renderer='',css='',stopping=false,scanTimer=null;
async function log(message) {await fs.appendFile(logFile,new Date().toISOString()+' '+message+'\n').catch(()=>{})}
async function assets() { [renderer,css]=await Promise.all([fs.readFile(rendererFile,'utf8'),fs.readFile(cssFile,'utf8')]) }
async function broadcast(profile,state) {
  await Promise.allSettled([...clients.values()].filter(c=>c.profile.id===profile.id).map(c=>c.cdp.evaluate('window.__codexUi?.updateState('+JSON.stringify(state)+')')));
}
async function operate(profile,operation) {
  const store=stores.get(profile.id);if(!store)throw Error('Профиль не настроен');
  const state=await store.operate(operation);await broadcast(profile,state);return state;
}
function script(client) {return renderer+'\ninstallCodexFolders('+JSON.stringify({state:stores.get(client.profile.id).state,css,profile:client.profile.id})+');'}
async function install(client) {
  if(stopping||client.installing||client.cdp.closed)return;client.installing=true;
  try {
    const valid=await client.cdp.evaluate('!!window.electronBridge?.getInitialSidebarBootstrap && window.codexWindowType === "electron"');
    if(!valid)return;
    await client.cdp.evaluate(script(client));client.installed=true;
    await log('Installed '+client.profile.id+' target '+client.id);
  } catch(error) {await log('Install '+client.profile.id+': '+error.message)}
  finally {client.installing=false}
}
async function attach(profile,target) {
  const key=profile.id+':'+target.id;if(clients.has(key)||connecting.has(key))return;connecting.add(key);
  try {
    const cdp=await CDP.open(target.webSocketDebuggerUrl);
    const client={id:target.id,profile,cdp,installed:false};clients.set(key,client);
    cdp.on('close',()=>clients.delete(key));
    cdp.on('Runtime.bindingCalled',async event=>{
      if(event.name!=='__codexUiHost')return;
      let request;
      try {
        request=JSON.parse(event.payload);
        if(typeof request.id!=='string'||!request.operation)throw Error('Invalid UI request');
        const state=await operate(profile,request.operation);
        await cdp.evaluate('window.__codexUi?.resolve('+JSON.stringify(request.id)+','+JSON.stringify({ok:true,state})+')');
      } catch(error) {
        if(request?.id)await cdp.evaluate('window.__codexUi?.resolve('+JSON.stringify(request.id)+','+JSON.stringify({ok:false,error:error.message})+')').catch(()=>{});
      }
    });
    cdp.on('Page.domContentEventFired',()=>install(client));
    await cdp.call('Runtime.enable');await cdp.call('Page.enable');
    await cdp.call('Runtime.addBinding',{name:'__codexUiHost'});
    await install(client);
  } catch(error) {await log('Attach '+profile.id+': '+error.message)}
  finally {connecting.delete(key)}
}
function mainTarget(target) {
  if(target.type!=='page'||!target.url?.startsWith('app://-/index.html'))return false;
  const url=new URL(target.url),route=url.searchParams.get('initialRoute')??'/';
  return !route.includes('prewarm=1')&&!route.startsWith('/avatar-overlay')&&!route.startsWith('/hotkey');
}
async function scan() {
  if(stopping)return;
  await Promise.allSettled(profiles.map(async profile=>{
    if(!stores.has(profile.id))return;
    try {
      const response=await fetch('http://127.0.0.1:'+profile.port+'/json/list',{signal:AbortSignal.timeout(1500)});
      const targets=await response.json();await Promise.allSettled(targets.filter(mainTarget).map(target=>attach(profile,target)));
    } catch {} // An account may be closed; the next scan reconnects it.
  }));
  if(!stopping)scanTimer=setTimeout(scan,2000);
}
async function shutdown() {
  if(stopping)return;stopping=true;clearTimeout(scanTimer);for(const watcher of watchers)watcher.close();
  await Promise.allSettled([...clients.values()].map(async client=>{await client.cdp.evaluate('window.__codexUi?.dispose()');client.cdp.close()}));
  await log('UI helper stopped');server.close();setTimeout(()=>process.exit(0),100).unref();
}
const server=net.createServer(socket=>{
  socket.setEncoding('utf8');let buffer='';
  socket.on('data',async chunk=>{
    buffer+=chunk;if(buffer.length>65536){socket.destroy();return}const end=buffer.indexOf('\n');if(end<0)return;
    try {
      const request=JSON.parse(buffer.slice(0,end));buffer='';let result;
      switch(request.command) {
        case 'status': result={pid:process.pid,profiles:profiles.map(p=>({id:p.id,file:path.join(p.home,'ui-folders.json'),revision:stores.get(p.id)?.state?.revision})),clients:[...clients.values()].map(c=>({profile:c.profile.id,id:c.id,installed:c.installed}))};break;
        case 'state': result=stores.get(request.profile)?.state;break;
        case 'operation': {const profile=profiles.find(p=>p.id===request.profile);if(!profile)throw Error('Неизвестный профиль');result=await operate(profile,request.operation);break;}
        case 'reload': await assets();await Promise.allSettled([...clients.values()].map(install));result={reloaded:true};break;
        case 'stop': socket.end(JSON.stringify({ok:true})+'\n');await shutdown();return;
        default: throw Error('Неизвестная команда');
      }
      socket.end(JSON.stringify({ok:true,result})+'\n');
    } catch(error) {socket.end(JSON.stringify({ok:false,error:error.message})+'\n')}
  });
  socket.on('error',()=>{});
});
server.on('error',error=>{if(error.code==='EADDRINUSE')process.exit(0);console.error(error);process.exit(1)});
server.listen(pipeName,async()=>{
  await log('UI helper starting, PID '+process.pid);
  await assets();
  for(const profile of profiles) {
    const store=new FolderStore(path.join(profile.home,'ui-folders.json'));
    try {await store.load();stores.set(profile.id,store)}catch(error){await log(profile.id+' config: '+error.message);continue}
    let reloadTimer;
    watchers.push(watch(profile.home,(_,name)=>{if(name!=='ui-folders.json')return;clearTimeout(reloadTimer);reloadTimer=setTimeout(async()=>{try{const old=JSON.stringify(store.state);const current=await store.reload();if(JSON.stringify(current)!==old)await broadcast(profile,current)}catch(error){await log(profile.id+' config retained: '+error.message)}},100)}));
  }
  let assetTimer;
  for(const file of [rendererFile,cssFile])watchers.push(watch(file,()=>{clearTimeout(assetTimer);assetTimer=setTimeout(async()=>{try{await assets();await Promise.allSettled([...clients.values()].map(install))}catch(error){await log('Asset reload: '+error.message)}},150)}));
  await scan();
});
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
process.on('uncaughtException',error=>{log('Fatal: '+error.stack).finally(()=>process.exit(1))});
process.on('unhandledRejection',error=>log('Unhandled: '+String(error)));
