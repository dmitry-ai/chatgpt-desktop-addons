export class CDP {
  constructor(socket) {
    this.socket=socket;this.sequence=0;this.pending=new Map();this.listeners=new Map();
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id) {const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(message.error.message)):request.resolve(message.result)}
      else for(const handler of this.listeners.get(message.method)??[])handler(message.params);
    });
    socket.addEventListener('close',()=>{for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(Error('CDP disconnected'))}this.pending.clear();this.closed=true;for(const handler of this.listeners.get('close')??[])handler()});
  }
  static async open(url) {
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(Error('CDP connect timeout'))},5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'))},{once:true})});
    return new CDP(socket);
  }
  on(event,handler) {const handlers=this.listeners.get(event)??new Set();handlers.add(handler);this.listeners.set(event,handlers)}
  call(method,params={}) {
    if(this.closed)return Promise.reject(Error('CDP disconnected'));
    return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(method+' timed out'))},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}))});
  }
  async evaluate(expression) {
    const result=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result?.value;
  }
  close() {this.socket.close()}
}
