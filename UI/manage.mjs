import net from 'node:net';
import {pipeName} from './paths.mjs';
export function control(request) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(pipeName);let data='';socket.setEncoding('utf8');socket.setTimeout(20000,()=>{socket.destroy();reject(Error('UI helper timeout'))});
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;socket.end();try{const response=JSON.parse(data.split('\n')[0]);response.ok?resolve(response.result):reject(Error(response.error))}catch(e){reject(e)}});
    socket.once('error',reject);
  });
}
if(process.argv[1]?.endsWith('manage.mjs')) {
  const command=process.argv[2]??'status';
  const request={command,profile:process.argv[3]??'C1'};
  if(command==='operation')request.operation=JSON.parse(process.argv[4]);
  try {console.log(JSON.stringify(await control(request),null,2))}catch(error){console.error(error.message);process.exitCode=1}
}
