import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const rawHome=os.homedir();
const appData=process.env.APPDATA?path.resolve(process.env.APPDATA):'';
export const userHome=(appData&&rawHome.toLowerCase().startsWith(appData.toLowerCase()+path.sep)&&process.env.LOCALAPPDATA)
  ?path.resolve(process.env.LOCALAPPDATA,'..','..')
  :rawHome;
export const pipeName='\\\\.\\pipe\\codex-ui-'+createHash('sha256').update(userHome.toLowerCase()).digest('hex').slice(0,16);
export const profiles=[
  {id:'C1',port:9223,home:process.env.CODEX_UI_C1_HOME??path.join(userHome,'.codex')},
  {id:'C2',port:9224,home:process.env.CODEX_UI_C2_HOME??path.join(process.env.APPDATA??path.join(userHome,'AppData','Roaming'),'Codex-Profile2')}
];
