import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pipeName} from './paths.mjs';
export function control(request) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(pipeName);let data='';socket.setEncoding('utf8');socket.setTimeout(20000,()=>{socket.destroy();reject(Error('UI helper timeout'))});
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;socket.end();try{const response=JSON.parse(data.split('\n')[0]);response.ok?resolve(response.result):reject(Error(response.error))}catch(e){reject(e)}});
    socket.once('error',reject);
  });
}

// Start only the existing hidden helper when the pipe is absent. Codex itself
// is never launched; offline profiles keep their durable catalogue queue.
export async function controlWithHelper(request){
  const absent=error=>['ENOENT','ECONNREFUSED'].includes(error.code);
  try{return await control(request);}catch(error){if(process.platform!=='win32'||!absent(error))throw error;}
  await new Promise((resolve,reject)=>{
    const child=spawn('wscript.exe',[fileURLToPath(new URL('./ensure-ui.vbs',import.meta.url))],{windowsHide:true,stdio:'ignore'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('UI helper launcher failed: '+code)));
  });
  const deadline=Date.now()+10000;
  while(true){
    try{return await control(request);}catch(error){if(!absent(error)||Date.now()>=deadline)throw error;}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
if(process.argv[1]?.endsWith('manage.mjs')) {
  const command=process.argv[2]??'status';
  let request={command,profile:process.argv[3]??'C1'};
  if(command==='request'){
    let input='';for await(const part of process.stdin)input+=part;
    request=JSON.parse(input);
  }
  if(command==='operation')request.operation=JSON.parse(process.argv[4]);
  try {console.log(JSON.stringify(await control(request),null,2))}catch(error){console.error(error.message);process.exitCode=1}
}
