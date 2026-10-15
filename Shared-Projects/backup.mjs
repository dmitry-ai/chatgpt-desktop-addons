import fs from 'node:fs/promises';
import path from 'node:path';
export async function backupProfiles(profiles, destination) {
  await fs.mkdir(destination,{recursive:true});
  const {DatabaseSync}=await import('node:sqlite');
  const manifest={createdAt:new Date().toISOString(),profiles:{}};
  for (const profile of profiles) {
    const folder=path.join(destination,profile.id);await fs.mkdir(folder,{recursive:true});
    const files=[];
    for (const name of ['.codex-global-state.json','ui-folders.json']) {
      try { const data=await fs.readFile(path.join(profile.home,name),'utf8');JSON.parse(data);await fs.writeFile(path.join(folder,name),data,{flag:'wx'});files.push(name); }
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const database=path.join(profile.home,'state_5.sqlite');
    try {
      await fs.access(database);
      const source=new DatabaseSync(database,{readOnly:true});
      try { source.exec("VACUUM INTO '"+path.join(folder,'state_5.sqlite').replaceAll("'","''")+"'"); }
      finally {source.close();}
      files.push('state_5.sqlite');
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    manifest.profiles[profile.id]={home:profile.home,files};
  }
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}