import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
export const pipeName='\\\\.\\pipe\\codex-ui-'+createHash('sha256').update(os.homedir().toLowerCase()).digest('hex').slice(0,16);
export const profiles=[
  {id:'C1',port:9223,home:process.env.CODEX_UI_C1_HOME??path.join(os.homedir(),'.codex')},
  {id:'C2',port:9224,home:process.env.CODEX_UI_C2_HOME??path.join(process.env.APPDATA??path.join(os.homedir(),'AppData','Roaming'),'Codex-Profile2')}
];
