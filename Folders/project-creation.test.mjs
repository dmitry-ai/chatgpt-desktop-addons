import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const renderer=fs.readFileSync(new URL('./renderer.js',import.meta.url),'utf8');
const functions=renderer.slice(renderer.indexOf('  function stopCreation('),renderer.indexOf('  function renameFolder('));
function fixture(){
  let listener,changed;const dialogs=[],operations=[],messages=[];
  const native={click(){dialogs.push({isConnected:true,querySelector:()=>true});}};
  const api=vm.compileFunction(`let creation=null,state={},revealProjectId=null;
    ${functions}
    return {createProject,context:()=>creation,reveal:()=>revealProjectId};`,
    ['window','document','MutationObserver','projectSection','closeDialog','notify','request','schedule','setTimeout','clearTimeout'])(
    {__codexSharedDesktop:{onLocalProjectCreating(fn){listener=fn;return()=>{listener=null;};}}},
    {body:{},querySelectorAll:()=>dialogs},
    class {constructor(fn){changed=fn;} observe(){} disconnect(){}},
    ()=>({querySelector:()=>native}),()=>{},message=>messages.push(message),
    async operation=>{operations.push(operation);return {};},()=>{},()=>1,()=>{}
  );
  return {api,dialogs,operations,messages,changed:()=>changed(),capture:()=>listener?.()};
}
test('folder action opens the native form and assigns its exact created project ID',async()=>{
  const f=fixture();f.api.createProject('nested-folder',{});
  assert.ok(f.api.context().dialog);
  await f.capture()('native-uuid');
  assert.deepEqual(f.operations,[{type:'assign-created-project',projectId:'native-uuid',folderId:'nested-folder'}]);
  assert.equal(f.api.reveal(),'native-uuid');assert.equal(f.api.context(),null);
});
test('cancel removes the creation subscription before an unrelated project can be created',()=>{
  const f=fixture();f.api.createProject('cancelled-folder',{});
  f.dialogs[0].isConnected=false;f.dialogs.length=0;f.changed();
  assert.equal(f.capture(),undefined);assert.equal(f.api.context(),null);assert.deepEqual(f.operations,[]);
});
test('a completed native request keeps its own folder even if another form opens meanwhile',async()=>{
  const f=fixture();f.api.createProject('first',{});const saved=f.capture();
  f.dialogs[0].isConnected=false;f.dialogs.length=0;f.changed();
  f.api.createProject('second',{});await saved('first-native-id');
  assert.equal(f.operations[0].folderId,'first');assert.equal(f.api.context().folderId,'second');
});
