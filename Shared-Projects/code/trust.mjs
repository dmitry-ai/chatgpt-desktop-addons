import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Shared-Projects owns the policy. A producer supplies its ID, never its scope.
export class TrustPolicy {
  constructor(file=fileURLToPath(new URL('./trust-policy.json',import.meta.url))){this.file=file;}
  async prepare(spec){
    if(spec?.trustPolicy===undefined)return spec;
    if(spec.trustPolicy!=='upwork-daily')throw Error('TRUST_POLICY: неизвестная политика доверия');
    const policy=JSON.parse(await fs.readFile(this.file,'utf8'));
    const runtime=JSON.parse(await fs.readFile(policy.upworkRuntime,'utf8'));
    if(!path.isAbsolute(runtime.workspace_root)||!runtime.daily_root||path.isAbsolute(runtime.daily_root))throw Error('TRUST_POLICY: некорректный каталог daily');
    const daily=path.resolve(runtime.workspace_root,runtime.daily_root),relativeDaily=path.relative(runtime.workspace_root,daily);
    if(!relativeDaily||relativeDaily==='..'||relativeDaily.startsWith('..'+path.sep)||path.isAbsolute(relativeDaily))throw Error('TRUST_POLICY: daily вне workspace');
    const scope=await fs.realpath(daily);
    if(!Array.isArray(spec.rootPaths)||spec.rootPaths.length!==1)throw Error('TRUST_POLICY: требуется один точный корень Upwork');
    for(const root of spec.rootPaths){
      if(typeof root!=='string'||!path.isAbsolute(root))throw Error('TRUST_POLICY: требуется абсолютный корень');
      const real=await fs.realpath(root),relative=path.relative(scope,real);
      if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!(await fs.stat(real)).isDirectory())throw Error('TRUST_POLICY: корень вне настроенного daily');
    }
    return spec;
  }
  async operation(project,operation,profile){
    if(!project.trustPolicy||operation.type!=='upsert')return null;
    await this.prepare({trustPolicy:project.trustPolicy,rootPaths:operation.value.rootPaths});
    return {policy:project.trustPolicy,roots:[...operation.value.rootPaths],configFile:path.join(profile.home,'config.toml')};
  }
}

// This function is also serialized into the renderer. It only uses an existing
// app-server connection and writes the exact native Windows path keys.
export async function ensureTrustedRoots(request,policy){
  if(!policy||policy.policy!=='upwork-daily'||!Array.isArray(policy.roots)||policy.roots.length!==1)throw Error('TRUST_POLICY: некорректная операция доверия');
  const key=value=>value.replaceAll('/','\\').replace(/^\\\\\?\\/,'').replace(/\\+$/,'').toLowerCase();
  const read=()=>request('config/read',{includeLayers:true,cwd:null});
  const before=await read();
  const user=before.layers?.filter(layer=>layer.name?.type==='user').at(-1);
  if(!user?.version||typeof user.name.file!=='string'||!/^\w:[\\/]/.test(user.name.file)||key(user.name.file)!==key(policy.configFile))throw Error('TRUST_PROFILE_MISMATCH: не подтверждён конфиг выбранного профиля Windows');
  const rejectUntrusted=response=>{for(const root of policy.roots){
    for(const config of [response.config,...(response.layers??[]).filter(l=>!l.disabledReason).map(l=>l.config)]){
      if(Object.entries(config?.projects??{}).some(([name,value])=>key(name)===key(root)&&value?.trust_level==='untrusted'))throw Error('UNTRUSTED_PROJECT: явное недоверие к '+root);
    }
  }};
  rejectUntrusted(before);
  const missing=policy.roots.filter(root=>before.config?.projects?.[root]?.trust_level!=='trusted');
  if(missing.length){
    const result=await request('config/batchWrite',{edits:missing.map(root=>({
      keyPath:'projects.'+JSON.stringify(root)+'.trust_level',value:'trusted',mergeStrategy:'replace'
    })),filePath:user.name.file,expectedVersion:user.version,reloadUserConfig:true});
    if(result?.status!=='ok')throw Error('TRUST_OVERRIDDEN: конфигурация не подтвердила доверие');
  }
  const after=await read();
  rejectUntrusted(after);
  if(policy.roots.some(root=>after.config?.projects?.[root]?.trust_level!=='trusted'))throw Error('TRUST_UNVERIFIED: эффективная конфигурация не подтверждает точный корень');
  return {status:'verified',roots:[...policy.roots],checkedAt:new Date().toISOString(),written:missing.length>0};
}
