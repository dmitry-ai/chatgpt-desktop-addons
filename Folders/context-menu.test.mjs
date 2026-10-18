import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const renderer=fs.readFileSync(new URL('./renderer.js',import.meta.url),'utf8');
const functions=renderer.slice(renderer.indexOf('  function closeContextMenu('),renderer.indexOf('  function syncTitle('));
function fixture(){
  const actions=[],registrations=[],popups=[],menuEntries=[];
  const row={isConnected:true,focus(){actions.push('focus')},closest(){return {};},querySelectorAll(){return [];}};
  const menu={attributes:{},style:{},offsetWidth:220,offsetHeight:90,setAttribute(key,value){this.attributes[key]=value;},append(entry){menuEntries.push(entry);},addEventListener(){},querySelector(){return {focus(){}};},remove(){actions.push('close');},contains(target){return target===this;}};
  const api=vm.compileFunction(`let contextMenu=null,contextOrigin=null,dialog=null;
    ${functions}
    return {projectContextMenu,dismissContextMenu,contextMenuKey,setMenu(){contextMenu=menu;contextOrigin=row;},setDialog(){dialog={};}};`,
    ['document','window','element','button','projectSection','nativeProject','assignProject','closeDialog','getComputedStyle','innerWidth','innerHeight','menu','row','actions'])(
    {body:{append(){}},addEventListener(...args){registrations.push(args);},querySelectorAll:()=>popups},
    {addEventListener(...args){registrations.push(args);},electronBridge:{showContextMenu(items){actions.push(['native-close',items]);return Promise.resolve({id:null});}}},
    ()=>menu,(label,text,action)=>({label,text,action,setAttribute(){}}),()=>true,
    ()=>({key:'local:project:native-id',id:'native-id',label:'Same name',row:{dataset:{appActionSidebarProjectLabel:'Same name'}}}),
    (...args)=>actions.push(['assign',...args]),()=>actions.push('dialog-close'),()=>({display:'block',visibility:'visible',opacity:'1'}),
    800,600,menu,row,actions);
  const event=(key='Escape',extra={})=>({key,target:{closest:()=>null},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra});
  return {api,actions,menuEntries,registrations,popups,row,menu,event};
}

test('right-click creates the project menu and uses the exact project key',()=>{
  const f=fixture(),e=f.event('ContextMenu',{target:{closest:()=>f.row},clientX:790,clientY:590});
  f.api.projectContextMenu(e);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);
  assert.equal(f.menuEntries[0].label,'Переместить в папку…');
  assert.equal(f.menu.attributes['data-state'],'open','The app must recognize our menu and suppress composer shortcuts');
  f.menuEntries[0].action();
  assert.deepEqual(f.actions,['close',['assign','local:project:native-id','Same name','native-id']]);
  assert.equal(f.menu.style.left,'572px');assert.equal(f.menu.style.top,'502px');
});

test('Escape closes our menu before a chat interrupt handler can receive it',()=>{
  const f=fixture();f.api.setMenu();const e=f.event();f.api.contextMenuKey(e);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.deepEqual(f.actions,['close','focus']);
});

test('moving a project reveals the destination branch and the exact project row',async()=>{
  const code=renderer.slice(renderer.indexOf('  function assignProject('),renderer.indexOf('  function closeContextMenu('));
  const folders=[{id:'outer',parentId:null},{id:'inner',parentId:'outer'}];
  let submit,revealed=false;const operations=[];
  let current={folders,collapsedFolderIds:['outer','inner'],projectFolderMap:{}};
  const api=vm.compileFunction(`let state=initial,revealProjectId=null;${code}\nreturn {assignProject,reveal:()=>revealProjectId};`,
    ['initial','closeContextMenu','openDialog','request','byId','schedule'])(current,()=>{},(_title,_build,onSubmit)=>{submit=onSubmit;},
    async operation=>{operations.push(operation);if(operation.type==='collapse')current={...current,collapsedFolderIds:current.collapsedFolderIds.filter(id=>id!==operation.id)};return current;},
    ()=>new Map(folders.map(folder=>[folder.id,folder])),()=>{revealed=true;});
  api.assignProject('local:project:exact','Same name','exact');await submit({value:'inner'});
  assert.deepEqual(operations,[{type:'assign',projectKey:'local:project:exact',folderId:'inner'},{type:'collapse',id:'inner',collapsed:false},{type:'collapse',id:'outer',collapsed:false}]);
  assert.equal(api.reveal(),'exact');assert.equal(revealed,true);
});

test('Escape with no overlay blocks chat cancellation and dismisses native popup menus',()=>{
  const f=fixture(),e=f.event();f.api.contextMenuKey(e);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.deepEqual(f.actions,[['native-close',[]]]);
});

test('Escape keeps native popup, input and terminal handling; closes our own dialog',()=>{
  const f=fixture();f.popups.push({hasAttribute:()=>false,getBoundingClientRect:()=>({width:100,height:100})});
  const popupEvent=f.event();f.api.contextMenuKey(popupEvent);assert.equal(popupEvent.stopped,undefined);
  f.popups.length=0;const inputEvent=f.event('Escape',{target:{closest:()=>({})}});f.api.contextMenuKey(inputEvent);assert.equal(inputEvent.stopped,undefined);
  f.api.setDialog();const dialogEvent=f.event();f.api.contextMenuKey(dialogEvent);assert.equal(dialogEvent.stopped,true);assert.deepEqual(f.actions,['dialog-close']);
});

test('outside pointer presses close our context menu',()=>{
  const f=fixture();f.api.setMenu();f.api.dismissContextMenu({target:{}});assert.deepEqual(f.actions,['close']);
  assert.ok(f.registrations.some(([type,,capture])=>type==='contextmenu'&&capture===true));
});

test('CDP installer puts Escape guard before existing capture handlers and retains their flags',()=>{
  const source=fs.readFileSync(new URL('../../UI/code/daemon.mjs',import.meta.url),'utf8');
  const script=source.match(/expression:`(\(\(\) => \{[\s\S]*?)`,includeCommandLineAPI:true/)[1];
  const native=()=>{},guard=()=>{},bubble=()=>{};
  let listeners=[{listener:native,useCapture:true,once:true,passive:false},{listener:guard,useCapture:true},{listener:bubble,useCapture:false}];
  const window={__codexUi:{handleEscape:guard},removeEventListener(type,listener){listeners=listeners.filter(entry=>entry.listener!==listener);},addEventListener(type,listener,options){listeners.push({listener,useCapture:options===true||options.capture,once:options.once,passive:options.passive});}};
  vm.runInNewContext(script,{window,getEventListeners:()=>({keydown:listeners})});
  assert.deepEqual(listeners.filter(entry=>entry.useCapture).map(entry=>entry.listener),[guard,native]);
  assert.equal(listeners.find(entry=>entry.listener===native).once,true);
  assert.equal(listeners.find(entry=>entry.listener===bubble).useCapture,false);
});
