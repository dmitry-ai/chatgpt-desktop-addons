import {connectScript} from './desktop.mjs';
import {observeProjects,planOperation,acknowledge,markStarted,failOperation,resumeSync,projectState,folderOperation,pendingCount,ensureProject,registrationReceipt} from './catalog.mjs';
const allowedEvents=new Set(['createLocal','editLocal','renameLocal','upsertLocal','removeLocal','setProjectOrder']);

export class ProjectSynchronizer{
  constructor({store,profiles,getClients,notify,log}){
    Object.assign(this,{store,profiles,getClients,notify,log});this.runners=new Map();this.health=new Map();this.stopping=false;this.timer=null;
    for(const p of profiles)this.health.set(p.id,{state:'offline'});
  }
  async attach(client){
    if(this.stopping||client.sharedConnecting||client.sharedReady||client.cdp.closed)return;
    if(client.sharedRetryAt>Date.now())return;
    client.sharedConnecting=true;
    try{
      const info=await client.cdp.evaluate(connectScript(),20000);
      client.sharedReady=true;client.sharedInfo={appVersion:info.appVersion,url:info.url,exportName:info.exportName};client.sharedRetryAt=0;
      this.health.set(client.profile.id,{state:'connected',appVersion:info.appVersion});
      await this.log('Shared projects connected '+client.profile.id+' '+info.appVersion+' '+info.exportName);
    }catch(error){
      client.sharedReady=false;client.sharedRetryAt=Date.now()+30000;
      await this.report(client.profile.id,error,'unsupported');
    }finally{client.sharedConnecting=false;}
  }
  status(){return Object.fromEntries(this.profiles.map(p=>[p.id,{...this.health.get(p.id),pending:pendingCount(this.store.state,p.id)}]));}
  projection(profile){return projectState(this.store.state,typeof profile==='string'?profile:profile.id,{accounts:this.status()});}
  async ensureProject(profileId,spec){
    const {result}=await this.store.transact(state=>ensureProject(state,profileId,spec));
    await this.notify();this.wakeAll();return result;
  }
  registration(id,profileId){return {...registrationReceipt(this.store.state,id,profileId),accounts:this.status()};}
  async operation(profile,operation){
    if(operation.type==='retry-sync'){
      await this.store.transact(resumeSync);
      for(const p of this.profiles){const h=this.health.get(p.id);if(h){delete h.manualRetry;delete h.error;delete h.retryAt;}for(const c of this.getClients().filter(c=>c.profile.id===p.id))c.sharedRetryAt=0;}
    }else await this.store.transact(s=>folderOperation(s,profile.id,operation));
    await this.notify();this.wakeAll();return this.projection(profile);
  }
  start(){this.timer=setInterval(()=>this.wakeAll(),2000);this.wakeAll();}
  wakeAll(){if(this.stopping)return;for(const p of this.profiles)this.wake(p.id);}
  wake(profileId){
    if(this.stopping)return Promise.resolve();
    let runner=this.runners.get(profileId);
    if(runner?.running){runner.again=true;return runner.promise;}
    runner={running:true,again:false,promise:null};this.runners.set(profileId,runner);
    runner.promise=this.run(profileId).catch(error=>this.report(profileId,error)).finally(async()=>{
      runner.running=false;await this.notify().catch(()=>{});
      if(runner.again&&!this.stopping)setTimeout(()=>this.wake(profileId),50);
    });return runner.promise;
  }
  async report(profile,error,state='paused'){
    const previous=this.health.get(profile)??{};
    const message=String(error?.message??error);
    if(previous.error!==message)await this.log('Shared projects '+profile+': '+message);
    this.health.set(profile,{...previous,state,error:message,retryAt:Date.now()+30000});
  }
  async collect(profile,client){
    const events=[];
    for(const c of this.getClients().filter(c=>c.profile.id===profile&&c.sharedReady&&!c.cdp.closed)){
      const pending=await c.cdp.evaluate('window.__codexSharedDesktop?.drainEvents()??[]');
      if(pending.some(e=>e.method==='overflow'))throw Error('Слишком много неподтверждённых изменений. Проверьте проекты перед повтором.');
      events.push(...pending.filter(e=>allowedEvents.has(e.method)));
    }
    const snapshot=await client.cdp.evaluate('window.__codexSharedDesktop.read()',20000);
    await this.store.transact(s=>{
      for(const event of events)observeProjects(s,profile,snapshot,event);
      observeProjects(s,profile,snapshot);
    });
    return snapshot;
  }
  async run(profile){
    const clients=this.getClients().filter(c=>c.profile.id===profile&&!c.cdp.closed&&c.installed);
    if(!clients.length){this.health.set(profile,{state:'offline'});return;}
    for(const c of clients)await this.attach(c);
    const client=clients.find(c=>c.sharedReady);
    if(!client)return;
    let snapshot=await this.collect(profile,client);
    await client.cdp.evaluate('window.__codexSharedDesktop.retainOperations('+JSON.stringify(this.store.state.operations.map(o=>o.id))+')');
    const pauseReason=this.store.state.profiles[profile].pauseReason;
    if(pauseReason){this.health.set(profile,{state:'paused',error:pauseReason,manualRetry:true,appVersion:client.sharedInfo?.appVersion});return;}
    if(this.health.get(profile)?.retryAt>Date.now())return;
    this.health.set(profile,{state:'connected',appVersion:client.sharedInfo?.appVersion});
    for(let count=0;count<8&&!this.stopping;count++){
      const {result:planned}=await this.store.transact(s=>planOperation(s,profile,snapshot));
      if(!planned)break;
      const {result:operation}=await this.store.transact(s=>markStarted(s,planned.id));
      if(!operation)continue;
      try{
        const allowStart=!this.store.state.conflicts.some(c=>c.projectId===operation.projectId);
        const result=await client.cdp.evaluate('window.__codexSharedDesktop.startOperation('+JSON.stringify(operation)+','+allowStart+')');
        if(result.state==='pending'){
          this.health.set(profile,{state:'waiting',appVersion:client.sharedInfo?.appVersion});return;
        }
        if(result.state==='blocked'){
          await this.store.transact(s=>failOperation(s,operation.id,'Conflict before dispatch'));
          this.health.set(profile,{state:'paused',error:'Операция ожидает разрешения конфликта',appVersion:client.sharedInfo?.appVersion});return;
        }
        if(result.state==='failed'){
          await this.store.transact(s=>failOperation(s,operation.id,result.error,{pause:result.error.includes('не подтвердило сохранение')}));
          await client.cdp.evaluate('window.__codexSharedDesktop.forgetOperation('+JSON.stringify(operation.id)+')');
          throw Error(result.error);
        }
        if(result.state!=='done')throw Error('Некорректный ответ операции Desktop App');
        await this.store.transact(s=>acknowledge(s,operation,result.result));
        await client.cdp.evaluate('window.__codexSharedDesktop.forgetOperation('+JSON.stringify(operation.id)+')');
        await this.log('Shared project '+operation.type+' applied to '+profile+': '+operation.projectId);
      }catch(error){
        await this.report(profile,error);
        if(String(error.message).includes('PROJECT_CHANGED')){snapshot=await this.collect(profile,client);continue;}
        return;
      }
      snapshot=await this.collect(profile,client);
    }
  }
  async stop(){this.stopping=true;clearInterval(this.timer);await Promise.allSettled([...this.runners.values()].map(r=>r.promise));}
}
