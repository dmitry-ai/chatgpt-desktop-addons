import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CDP} from './cdp.mjs';
import {profiles,pipeName} from './paths.mjs';
import {createC1Recovery} from './recovery.mjs';
import {CatalogStore,catalogFile} from '../../Shared-Projects/code/catalog.mjs';
import {ProjectSynchronizer} from '../../Shared-Projects/code/sync.mjs';

const code=path.dirname(fileURLToPath(import.meta.url));
const rendererFile=path.resolve(code,'../../Folders/code/renderer.js');
const cssFile=path.resolve(code,'../../CSS/code/style.css');
const logFile=path.join(code,'ui.log');
const clients=new Map(),connecting=new Set(),watchers=[];
const catalog=new CatalogStore();
const recovery=createC1Recovery(profiles.find(p=>p.id==='C1').home,log);
let shared=null,renderer='',css='',stopping=false,scanTimer=null,startupError=null;
async function log(message){await fs.appendFile(logFile,new Date().toISOString()+' '+message+'\n').catch(()=>{});}
async function assets(){[renderer,css]=await Promise.all([fs.readFile(rendererFile,'utf8'),fs.readFile(cssFile,'utf8')]);}
function state(profile){
  if(shared)return shared.projection(profile);
  return {schemaVersion:1,revision:0,folders:[],projectFolderMap:{},collapsedFolderIds:[],sync:{shared:true,accounts:Object.fromEntries(profiles.map(p=>[p.id,{state:'paused',error:startupError??'Инициализация'}])),profiles:[],conflicts:[]}};
}
async function broadcast(){
  await Promise.allSettled([...clients.values()].filter(c=>c.installed&&!c.cdp.closed).map(async client=>{
    const value=state(client.profile),serialized=JSON.stringify(value);
    if(client.lastState===serialized)return;
    await client.cdp.evaluate('window.__codexUi?.updateState('+serialized+')');client.lastState=serialized;
  }));
}
async function operate(profile,operation){
  if(!shared)throw Error(startupError??'Общий каталог ещё не готов');
  return shared.operation(profile,operation);
}
async function install(client){
  if(stopping||client.installing||client.cdp.closed)return;client.installing=true;
  try{
    const valid=await client.cdp.evaluate('!!window.electronBridge?.getInitialSidebarBootstrap && window.codexWindowType === "electron"');
    if(!valid)return;
    await client.cdp.evaluate(renderer+'\ninstallCodexFolders('+JSON.stringify({state:state(client.profile),css,profile:client.profile.id})+');');
    client.installed=true;client.lastState=null;
    await log('Installed '+client.profile.id+' target '+client.id);
  }catch(error){await log('Install '+client.profile.id+': '+error.message);}
  finally{client.installing=false;}
  shared?.wake(client.profile.id);
}
async function attach(profile,target){
  const key=profile.id+':'+target.id,existing=clients.get(key);
  if(existing){if(!existing.installed)await install(existing);return;}
  if(connecting.has(key))return;connecting.add(key);
  try{
    const cdp=await CDP.open(target.webSocketDebuggerUrl),client={id:target.id,profile,cdp,installed:false};clients.set(key,client);
    cdp.on('close',()=>{if(clients.get(key)===client)clients.delete(key);shared?.wake(profile.id);});
    cdp.on('Runtime.bindingCalled',async event=>{
      if(event.name==='__codexSharedChanged'){shared?.wake(profile.id);return;}
      if(event.name!=='__codexUiHost')return;
      let request;
      try{
        request=JSON.parse(event.payload);
        if(typeof request.id!=='string'||!request.operation)throw Error('Invalid UI request');
        const value=await operate(profile,request.operation);
        await cdp.evaluate('window.__codexUi?.resolve('+JSON.stringify(request.id)+','+JSON.stringify({ok:true,state:value})+')');
      }catch(error){
        if(request?.id)await cdp.evaluate('window.__codexUi?.resolve('+JSON.stringify(request.id)+','+JSON.stringify({ok:false,error:error.message})+')').catch(()=>{});
      }
    });
    cdp.on('Page.domContentEventFired',()=>{client.installed=false;client.sharedReady=false;client.sharedRetryAt=0;install(client);});
    await cdp.call('Runtime.enable');await cdp.call('Page.enable');
    await cdp.call('Runtime.addBinding',{name:'__codexUiHost'});
    await cdp.call('Runtime.addBinding',{name:'__codexSharedChanged'});
    await install(client);
  }catch(error){await log('Attach '+profile.id+': '+error.message);}
  finally{connecting.delete(key);}
}
function mainTarget(target){
  if(target.type!=='page'||!target.url?.startsWith('app://-/index.html'))return false;
  const route=new URL(target.url).searchParams.get('initialRoute')??'/';
  return !route.includes('prewarm=1')&&!route.startsWith('/avatar-overlay')&&!route.startsWith('/hotkey');
}
async function scan(){
  if(stopping)return;
  await Promise.allSettled(profiles.map(async profile=>{
    try{
      const response=await fetch('http://127.0.0.1:'+profile.port+'/json/list',{signal:AbortSignal.timeout(1500)});
      const targets=await response.json();await Promise.allSettled(targets.filter(mainTarget).map(target=>attach(profile,target)));
    }catch{} // Closed accounts reconnect automatically.
  }));
  const c1=[...clients.values()].some(c=>c.profile.id==='C1'&&c.installed&&!c.cdp.closed);
  if(c1){
    if(recovery&&recovery.status.state!=='connected'){
      await log('C1 UI recovery verified: Folders/CSS installed');recovery.connected();
    }
  }else await recovery?.tick();
  if(!stopping)scanTimer=setTimeout(scan,2000);
}
async function shutdown(){
  if(stopping)return;stopping=true;clearTimeout(scanTimer);for(const watcher of watchers)watcher.close();
  recovery?.stop();
  await shared?.stop();
  await Promise.allSettled([...clients.values()].map(async client=>{await client.cdp.evaluate('window.__codexSharedDesktop?.dispose();window.__codexUi?.dispose()');client.cdp.close();}));
  await log('UI helper stopped');server.close();setTimeout(()=>process.exit(0),100).unref();
}
const server=net.createServer(socket=>{
  socket.setEncoding('utf8');let buffer='';
  socket.on('data',async chunk=>{
    buffer+=chunk;if(buffer.length>65536){socket.destroy();return;}const end=buffer.indexOf('\n');if(end<0)return;
    try{
      const request=JSON.parse(buffer.slice(0,end));buffer='';let result;
      switch(request.command){
        case 'status':result={pid:process.pid,ready:!!shared,error:startupError,recovery:recovery?.status,shared:{file:catalogFile,revision:catalog.state?.revision,projects:Object.values(catalog.state?.projects??{}).filter(p=>!p.deleted).length,folders:catalog.state?.folders.length,conflicts:catalog.state?.conflicts,accounts:shared?.status()},profiles:profiles.map(p=>({id:p.id,file:catalogFile,revision:catalog.state?.revision})),clients:[...clients.values()].map(c=>({profile:c.profile.id,id:c.id,installed:c.installed,sharedReady:!!c.sharedReady,appVersion:c.sharedInfo?.appVersion}))};break;
        case 'state':result=state(request.profile??'C1');break;
        case 'operation':{const profile=profiles.find(p=>p.id===request.profile);if(!profile)throw Error('Неизвестный профиль');result=await operate(profile,request.operation);break;}
        case 'shared-catalog':result=catalog.state;break;
        case 'shared-ensure-project':{
          if(!shared)throw Error(startupError??'Общий каталог ещё не готов');
          for(const root of request.project?.rootPaths??[]){if(!(await fs.stat(root)).isDirectory())throw Error('Рабочий каталог проекта не существует');}
          result=await shared.ensureProject(request.profile,request.project);break;
        }
        case 'shared-registration':{
          if(!shared)throw Error(startupError??'Общий каталог ещё не готов');
          result=shared.registration(request.sharedId,request.profile);break;
        }
        case 'shared-sync':shared?.wakeAll();result={queued:true};break;
        case 'shared-reconnect':for(const [key,c]of clients)if(!request.profile||c.profile.id===request.profile){await c.cdp.evaluate('window.__codexSharedDesktop?.dispose()');c.cdp.close();clients.delete(key);}result={reconnecting:true};break;
        case 'reload':await assets();await Promise.allSettled([...clients.values()].map(install));result={reloaded:true};break;
        case 'stop':socket.end(JSON.stringify({ok:true})+'\n');await shutdown();return;
        default:throw Error('Неизвестная команда');
      }
      socket.end(JSON.stringify({ok:true,result})+'\n');
    }catch(error){socket.end(JSON.stringify({ok:false,error:error.message})+'\n');}
  });socket.on('error',()=>{});
});
server.on('error',error=>{if(error.code==='EADDRINUSE')process.exit(0);console.error(error);process.exit(1);});
server.listen(pipeName,async()=>{
  await log('UI helper starting, PID '+process.pid);await assets();
  try{
    await catalog.load(profiles);
    shared=new ProjectSynchronizer({store:catalog,profiles,getClients:()=>[...clients.values()],notify:broadcast,log});shared.start();
  }catch(error){startupError='Не удалось открыть общий каталог: '+error.message;await log(startupError);}
  let assetTimer;
  for(const file of [rendererFile,cssFile])watchers.push(watch(file,()=>{clearTimeout(assetTimer);assetTimer=setTimeout(async()=>{try{await assets();await Promise.allSettled([...clients.values()].map(install));}catch(error){await log('Asset reload: '+error.message);}},150);}));
  await scan();
});
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
process.on('uncaughtException',error=>{log('Fatal: '+error.stack).finally(()=>process.exit(1));});
process.on('unhandledRejection',error=>log('Unhandled: '+String(error)));
