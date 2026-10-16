import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

// Read only lifecycle metadata. Chat text is neither retained nor copied.
export class TurnLog {
  constructor(since){this.since=since;this.offset=0;this.carry='';this.decoder=new StringDecoder('utf8');this.active=new Set();this.error=null;}
  push(chunk){
    this.offset+=chunk.length;this.carry+=this.decoder.write(chunk);
    let end;
    while((end=this.carry.indexOf('\n'))>=0){
      const line=this.carry.slice(0,end);this.carry=this.carry.slice(end+1);if(!line.trim())continue;
      let row;try{row=JSON.parse(line);}catch{this.error='Incomplete or invalid session lifecycle data';continue;}
      if(row.type!=='event_msg'||Date.parse(row.timestamp)<this.since)continue;
      const event=row.payload;
      if(event?.type==='task_started'){
        if(typeof event.turn_id!=='string')this.error='Unknown task_started format';else this.active.add(event.turn_id);
      }else if(event?.type==='task_complete'||event?.type==='turn_aborted'){
        if(typeof event.turn_id==='string')this.active.delete(event.turn_id);
        else this.error='Unknown task completion format';
      }
    }
  }
}

export class SessionActivity {
  constructor(home){this.root=path.join(home,'sessions');this.logs=new Map();this.since=null;}
  async files(directory=this.root){
    const result=[];
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())result.push(...await this.files(file));
      else if(entry.isFile()&&entry.name.endsWith('.jsonl'))result.push(file);
    }
    return result;
  }
  async read(startedAt,now){
    const since=Date.parse(startedAt);
    if(!Number.isFinite(since))throw Error('C1 process start time is unavailable');
    if(this.since!==since){this.since=since;this.logs.clear();}
    let latest=since,active=0;
    for(const file of await this.files()){
      const stat=await fs.stat(file);if(stat.mtimeMs<since)continue;
      latest=Math.max(latest,stat.mtimeMs);
      let log=this.logs.get(file);
      if(!log||stat.size<log.offset){log=new TurnLog(since);this.logs.set(file,log);}
      if(stat.size>log.offset)for await(const chunk of createReadStream(file,{start:log.offset,end:stat.size-1}))log.push(chunk);
      if(log.error)throw Error(log.error);
      active+=log.active.size;
      if(log.carry.trim())active++; // A record is still being written: wait.
    }
    return {active,quiet:now-latest>=5000};
  }
}

export class C1Recovery {
  constructor({probe,recover,activity,log=async()=>{}}){
    Object.assign(this,{probe,recover,activity,log});this.status={state:'initializing'};this.nextProbe=0;this.blocked=false;
  }
  connected(){this.blocked=false;this.status={state:'connected'};this.nextProbe=0;}
  async tick(now=Date.now()){
    if(this.stopped||this.blocked||now<this.nextProbe)return;
    this.nextProbe=now+2000;
    try{
      const process=await this.probe();
      if(this.stopped)return;
      if(!process){this.status={state:'closed'};this.nextProbe=now+15000;return;}
      if(process.HasDebugPort){this.status={state:'waiting-for-ui',pid:process.Pid};return;}
      if(!process.RestartRegistered)throw Error('C1 is not registered for graceful Windows restart');
      const activity=await this.activity(process.StartedAt,now);
      if(this.stopped)return;
      this.status={state:activity.active?'waiting-for-turns':'waiting-for-idle',pid:process.Pid,activeTurns:activity.active};
      if(activity.active||!activity.quiet)return;
      // Recheck immediately before making the request; native code also pins
      // and revalidates the exact process, then asks Windows to close it gently.
      const confirmed=await this.activity(process.StartedAt,Date.now());
      if(this.stopped||confirmed.active||!confirmed.quiet)return;
      this.blocked=true;this.status={state:'restarting',pid:process.Pid};
      await this.log('C1 lost its UI launch flag; graceful recovery of PID '+process.Pid);
      const pid=await this.recover(process);
      this.status={state:'waiting-for-verification',pid};
      await this.log('C1 relaunched with --remote-debugging-port=9223, PID '+pid);
    }catch(error){this.blocked=true;this.status={state:'error',error:error.message};await this.log('C1 recovery stopped: '+error.message);}
  }
}

// One private stdio worker; no new listener, scheduled task, registry entry or
// on-disk build is needed. The C# package resolver is shared with the C2 launcher.
class NativeRuntime {
  async call(request){
    if(this.pending)throw Error('C1 runtime request is already in progress');
    if(!this.child){
      const executable=path.join(process.env.WINDIR??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      this.child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./c1-runtime.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      this.buffer='';this.stderr='';
      this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
      this.child.stdout.on('data',chunk=>{
        this.buffer+=chunk;const end=this.buffer.indexOf('\n');if(end<0)return;
        const line=this.buffer.slice(0,end).replace(/^\uFEFF/,'');this.buffer=this.buffer.slice(end+1);
        try{const response=JSON.parse(line);response.ok?this.finish(null,response.result):this.finish(Error(response.error));}
        catch(error){this.finish(error);}
      });
      this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk).slice(-4000);});
      this.child.on('error',error=>this.finish(error));
      this.child.on('exit',()=>{this.child=null;this.finish(Error(this.stderr.trim()||'C1 runtime worker exited'));});
      this.child.stdin.on('error',error=>this.finish(error));
    }
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.finish(Error('C1 runtime request timed out')),45000);
      this.pending={resolve,reject,timer};this.child.stdin.write(JSON.stringify(request)+'\n');
    });
  }
  finish(error,result){const pending=this.pending;if(!pending)return;this.pending=null;clearTimeout(pending.timer);error?pending.reject(error):pending.resolve(result);}
  close(){this.child?.stdin.end();}
}

export function createC1Recovery(home,log){
  if(process.platform!=='win32')return null;
  const runtime=new NativeRuntime(),activity=new SessionActivity(home);
  const recovery=new C1Recovery({
    probe:()=>runtime.call({command:'probe'}),
    recover:process=>runtime.call({command:'recover',pid:process.Pid,startTicks:process.StartTicks}),
    activity:(startedAt,now)=>activity.read(startedAt,now),log,
  });
  recovery.stop=()=>{recovery.stopped=true;runtime.close();};
  return recovery;
}
