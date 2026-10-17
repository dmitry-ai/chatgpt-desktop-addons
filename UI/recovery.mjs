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
  constructor({probe,recover,activity,log=async()=>{},allowAutomaticRestart=false}){
    Object.assign(this,{probe,recover,activity,log,allowAutomaticRestart});this.status={state:'initializing'};this.nextProbe=0;this.blocked=false;
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
      if(!this.allowAutomaticRestart){this.status={state:'waiting-for-manual-launch',pid:process.Pid};return;}
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

// The app writes this marker only while preparing a user-requested update.
// Keep lifecycle metadata; never retain or copy other desktop-log content.
export class UpdateIntentLog {
  constructor(root){this.root=root;this.seen=new Map();this.intent=null;}
  async read(process,now=Date.now()){
    for(const time of [now,now-86400000]){
      const date=new Date(time).toISOString().slice(0,10).split('-');
      const directory=path.join(this.root,...date);
      let names;try{names=await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const pattern=new RegExp('^codex-desktop-[a-f0-9-]{36}-'+process.Pid+'-t0-.*\\.log$');
      for(const name of names.filter(name=>pattern.test(name))){
        const file=path.join(directory,name),stat=await fs.stat(file);
        let offset=this.seen.get(file)??Math.max(0,stat.size-65536);
        if(offset>stat.size)offset=0;
        if(offset===stat.size)continue;
        const chunks=[];for await(const chunk of createReadStream(file,{start:offset,end:stat.size-1}))chunks.push(chunk);
        const bytes=Buffer.concat(chunks);
        // Leave an incomplete record for the next read rather than accepting it.
        const end=bytes.lastIndexOf(10);if(end<0)continue;
        this.seen.set(file,offset+end+1);
        for(const line of bytes.subarray(0,end).toString('utf8').split('\n')){
          const match=/^(\S+) info update_resume_state_saved threadCount=\d+\s*$/.exec(line);
          const at=match?Date.parse(match[1]):NaN;
          if(at>=Date.parse(process.StartedAt)&&at<=now&&now-at<=120000)this.intent={at,pid:process.Pid,startTicks:process.StartTicks};
        }
      }
    }
    return this.intent?.pid===process.Pid&&this.intent.startTicks===process.StartTicks&&now-this.intent.at<=120000?this.intent:null;
  }
}

export class UpdateRecovery {
  constructor({probe,prepare,launch,recover,activity,intent,log=async()=>{}}){
    Object.assign(this,{probe,prepare,launch,recover,activity,intent,log});
    this.status={state:'watching'};this.nextProbe=0;this.handled=new Set();
  }
  async tick(now=Date.now(),uiReady=false){
    if(this.stopped||now<this.nextProbe)return;
    this.nextProbe=now+2000;
    try{
      const current=await this.probe();if(this.stopped)return;
      if(this.failed){
        if(uiReady){this.failed=false;this.pending=null;this.previous=current;this.status={state:'watching',lastError:this.status.error};}
        return;
      }
      // Inspect the previous process's final records even after it has exited.
      if(!this.pending&&this.previous){
        const intent=await this.intent(this.previous,now);
        if(intent&&!this.handled.has(intent.at)){
          this.pending={origin:this.previous,intent,deadline:intent.at+120000};
          this.handled.add(intent.at);await this.log('User-requested C1 update observed, PID '+this.previous.Pid);
        }
      }
      if(!this.pending){this.previous=current;return;}
      const task=this.pending;
      if(now>task.deadline)throw Error('Update did not reach a verified C1 UI within two minutes');
      if(current?.Pid===task.origin.Pid&&current.StartTicks===task.origin.StartTicks){
        this.status={state:'waiting-for-updater-exit',pid:current.Pid};return;
      }
      if(current){
        const version=value=>{
          const match=/^OpenAI\.Codex_(\d+)\.(\d+)\.(\d+)\.(\d+)_/.exec(value??'');
          if(!match)throw Error('Unknown running package identity');return match.slice(1).map(Number);
        };
        const before=version(task.origin.Package),after=version(current.Package);
        const difference=after.map((n,i)=>n-before[i]).find(n=>n!==0)??0;
        if(difference<=0)throw Error('The updater reopened an older or unchanged package; automatic recovery stopped');
        if(current.HasDebugPort){
          if(uiReady){this.status={state:'verified',pid:current.Pid,package:current.Package};this.previous=current;this.pending=null;await this.log('Updated C1 verified: new package and Folders/CSS connected');}
          else this.status={state:'waiting-for-ui',pid:current.Pid};
          return;
        }
        // Only a newborn, post-update instance may be corrected automatically.
        // A long-running session remains under the user's control.
        if(now-Date.parse(current.StartedAt)>20000)throw Error('C1 is already in use; reopen its shortcut when convenient');
        if(task.restarted)throw Error('The replacement C1 still has no UI launch flag');
        if(!current.RestartRegistered)throw Error('Updated C1 does not support graceful Windows restart');
        // Include answers resumed from before the updater closed the old app.
        const state=await this.activity(task.origin.StartedAt,now);
        if(this.stopped)return;
        if(state.active||!state.quiet){this.status={state:'waiting-for-turns',pid:current.Pid};return;}
        const confirmed=await this.activity(task.origin.StartedAt,Date.now());
        if(this.stopped||confirmed.active||!confirmed.quiet)return;
        task.restarted=true;await this.recover(current);
        this.status={state:'waiting-for-ui'};return;
      }
      this.status={state:'registering'};
      const prepared=await this.prepare(task.origin);if(this.stopped)return;
      if(!prepared.Ready){this.status={state:'waiting-for-other-apps',package:prepared.PendingPackage};return;}
      if(!prepared.Newer)throw Error('Windows has not registered a newer package; the previous version was not relaunched');
      if(task.launched)throw Error('The updated C1 exited before UI verification; automatic launch will not repeat');
      task.launched=true;
      const pid=await this.launch();this.status={state:'waiting-for-ui',pid};
    }catch(error){
      this.failed=true;this.status={state:'error',error:error.message};await this.log('C1 update recovery stopped: '+error.message);
    }
  }
  get handling(){return !!this.pending&&!this.failed;}
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
  const intents=new UpdateIntentLog(path.join(process.env.LOCALAPPDATA,'Codex','Logs'));
  const updates=new UpdateRecovery({
    probe:()=>runtime.call({command:'probe'}),
    prepare:origin=>runtime.call({command:'prepare-update',originPackage:origin.Package}),
    launch:()=>runtime.call({command:'launch'}),
    recover:process=>runtime.call({command:'recover',pid:process.Pid,startTicks:process.StartTicks}),
    activity:(startedAt,now)=>activity.read(startedAt,now),intent:(process,now)=>intents.read(process,now),log,
  });
  recovery.updates=updates;
  recovery.stop=()=>{recovery.stopped=true;updates.stopped=true;runtime.close();};
  return recovery;
}
