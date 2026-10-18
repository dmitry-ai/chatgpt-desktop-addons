// Runs in the app renderer. Native project DOM nodes stay with their React parent.
function installCodexFolders(options) {
  window.__codexUi?.dispose();
  const {state:initial,css,profile}=options;
  let state=initial,disposed=false,timer=null,dialog=null,toastTimer=null,renderedRevision=-1;
  let creation=null,revealProjectId=null;
  const roots=new Map(),pending=new Map(),nativeNodes=new Set(),rowButtons=new Map(),toolbars=new Map(),fallbacks=new Map(),paginationStyles=new Map(),expansionRequests=new Map();
  const byId=()=>new Map(state.folders.map(f=>[f.id,f]));
  const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
  const style=document.createElement('style');style.dataset.codexUi='style';style.textContent=css;
  const icon='<svg class="cui-folder-icon" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2-2h7a1 1 0 0 1 1 1v12H2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  function element(tag,className,text) {const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e}
  function button(label,text,action,className='') {
    const b=element('button','cui-button '+className,text);b.type='button';b.title=label;b.setAttribute('aria-label',label);
    b.addEventListener('pointerdown',e=>e.stopPropagation());
    b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();action(e)});return b;
  }
  function request(operation) {
    const id=crypto.randomUUID();return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{pending.delete(id);reject(Error('Нет ответа от модуля папок. Повторно откройте ярлык '+profile))},10000);
      pending.set(id,{resolve,reject,timeout});
      try {window.__codexUiHost(JSON.stringify({id,operation}))}catch(error){clearTimeout(timeout);pending.delete(id);reject(error)}
    });
  }
  function notify(message) {
    document.querySelector('.cui-toast')?.remove();clearTimeout(toastTimer);
    const t=element('div','cui-toast',message);t.setAttribute('role','status');document.body.append(t);
    toastTimer=setTimeout(()=>t.remove(),7000);
  }
  function act(operation) {return request(operation).catch(error=>notify(error.message))}
  function pathOf(id) {const map=byId(),names=[];while(id&&map.has(id)){const f=map.get(id);names.unshift(f.name);id=f.parentId}return names.join(' / ')}
  function descendant(id,parentId) {const map=byId();while(parentId){if(id===parentId)return true;parentId=map.get(parentId)?.parentId}return false}
  function sortedFolders(parentId) {return state.folders.filter(f=>f.parentId===parentId).sort((a,b)=>collator.compare(a.name,b.name))}
  function openDialog(title,build,onSubmit,submitText='Сохранить') {
    closeDialog();dialog=element('dialog','cui-dialog');const form=element('form');
    const h=element('h2','',title);form.append(h);const fields=build(form);
    const error=element('div','cui-error');error.setAttribute('role','alert');form.append(error);
    const footer=element('div','cui-dialog-footer');
    const cancel=element('button','','Отмена');cancel.type='button';cancel.onclick=closeDialog;
    const save=element('button','',submitText);save.type='submit';footer.append(cancel,save);form.append(footer);dialog.append(form);
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;error.textContent='';try{await onSubmit(fields);closeDialog()}catch(e){error.textContent=e.message;save.disabled=false}};
    dialog.addEventListener('close',event=>{const closed=event.currentTarget;closed.remove();if(dialog===closed)dialog=null});document.body.append(dialog);dialog.showModal();
    const input=form.querySelector('input,select');input?.focus();if(input?.tagName==='INPUT')input.select();return fields;
  }
  function closeDialog() {if(dialog){const old=dialog;dialog=null;old.close();old.remove()}}
  function inputField(form,label,value='') {const l=element('label','',label),input=element('input');input.value=value;input.required=true;input.maxLength=160;l.append(input);form.append(l);return input}
  function folderField(form,current=null,excluded=null) {
    const label=element('label','','Расположение'),select=element('select');
    const root=element('option','','(Корень)');root.value='';select.append(root);
    function visit(parentId,depth=0){for(const f of sortedFolders(parentId)){if(excluded&&descendant(excluded,f.id))continue;const o=element('option','','  '.repeat(depth)+f.name);o.value=f.id;select.append(o);visit(f.id,depth+1)}}
    visit(null);select.value=current??'';label.append(select);form.append(label);return select;
  }
  function createFolder(parentId=null,projectKey=null) {
    openDialog('Новая папка',form=>({name:inputField(form,'Имя'),parent:folderField(form,parentId)}),async fields=>{
      const id=crypto.randomUUID();await request({type:'create',id,name:fields.name.value,parentId:fields.parent.value||null});
      if(projectKey)await request({type:'assign',projectKey,folderId:id});
    },'Создать');
  }
  function stopCreation(context=creation){
    if(!context)return;
    context.observer?.disconnect();context.unsubscribe?.();clearTimeout(context.timeout);
    if(creation===context)creation=null;
  }
  function createProject(folderId,list){
    closeDialog();stopCreation();
    const native=projectSection(list)?.querySelector('[data-app-action-sidebar-project-create]');
    const service=window.__codexSharedDesktop;
    if(!native||typeof service?.onLocalProjectCreating!=='function'){notify('Создание проектов ещё не подключено. Повторите через несколько секунд.');return;}
    const context={folderId,dialog:null,previous:new Set(document.querySelectorAll('[role=dialog]'))};
    creation=context;
    const track=()=>{
      if(context.dialog){if(!context.dialog.isConnected)stopCreation(context);return;}
      context.dialog=[...document.querySelectorAll('[role=dialog]')].find(d=>!context.previous.has(d)&&d.querySelector('form'))??null;
      if(context.dialog)clearTimeout(context.timeout);
    };
    context.observer=new MutationObserver(track);context.observer.observe(document.body,{childList:true,subtree:true});
    context.unsubscribe=service.onLocalProjectCreating(()=>{
      track();if(creation!==context||!context.dialog?.isConnected)return null;
      return async projectId=>{
        stopCreation(context);
        try{
          state=await request({type:'assign-created-project',projectId,folderId});
          revealProjectId=projectId;schedule();
        }catch(error){notify('Проект создан, но не удалось поместить его в папку: '+error.message);}
      };
    });
    context.timeout=setTimeout(()=>stopCreation(context),15000);
    native.click();track();
  }
  function renameFolder(id) {const f=byId().get(id);if(f)openDialog('Переименовать папку',form=>inputField(form,'Имя',f.name),field=>request({type:'rename',id,name:field.value}))}
  function folderMenu(id,list) {
    const f=byId().get(id);if(!f)return;
    openDialog(f.name,form=>{
      const name=inputField(form,'Имя',f.name),parent=folderField(form,f.parentId,id);
      const actions=element('div','cui-dialog-footer');
      const project=element('button','','Создать проект…');project.type='button';project.onclick=()=>createProject(id,list);
      const add=element('button','','Подпапка');add.type='button';add.onclick=()=>createFolder(id);
      const remove=element('button','','Удалить папку');remove.type='button';remove.onclick=()=>removeFolder(id);
      actions.append(project,add,remove);form.append(actions);return {name,parent};
    },async fields=>{
      // A combined operation avoids partial rename/move results.
      await request({type:'edit',id,name:fields.name.value,parentId:fields.parent.value||null});
    });
  }
  function removeFolder(id) {
    const f=byId().get(id);if(!f)return;
    openDialog('Удалить папку «'+f.name+'»?',form=>{form.append(element('p','','Подпапки и проекты будут подняты к родителю. Проекты и чаты сохранятся.'))},()=>request({type:'remove',id}),'Удалить папку');
  }
  function assignProject(projectKey,label) {
    openDialog('Папка проекта «'+label+'»',form=>{
      const target=folderField(form,state.projectFolderMap[projectKey]);
      const add=element('button','','Новая папка…');add.type='button';add.onclick=()=>createFolder(target.value||null,projectKey);form.append(add);return target;
    },select=>request({type:'assign',projectKey,folderId:select.value||null}));
  }
  function syncTitle() {
    const sync=state.sync;if(!sync?.shared)return '';
    if(sync.conflicts?.length)return 'Общие проекты: требуется выбрать изменения';
    const accounts=Object.entries(sync.accounts??{});
    if(accounts.some(([,a])=>['paused','unsupported'].includes(a.state)))return 'Общие проекты: синхронизация приостановлена';
    if(accounts.some(([,a])=>a.state==='waiting'))return 'Общие проекты: ожидает ответа приложения';
    if(accounts.some(([,a])=>a.pending>0))return 'Общие проекты: есть ожидающие изменения';
    return 'Общие проекты: синхронизировано';
  }
  function sharedStatus() {
    const sync=state.sync;if(!sync?.shared)return;
    openDialog('Общие проекты',form=>{
      form.append(element('p','',syncTitle().replace('Общие проекты: ','')));
      for(const [id,account]of Object.entries(sync.accounts??{})){
        const label=account.state==='offline'?'закрыт':account.state==='connected'?'подключён':account.state==='waiting'?'ожидает ответа приложения':'приостановлено';
        form.append(element('p','',id+' — '+label+(account.pending?' · ожидает изменений: '+account.pending:'')));
        if(account.error)form.append(element('p','cui-error',account.error));
      }
      if(Object.values(sync.accounts??{}).some(a=>a.state==='waiting'))form.append(element('p','','Если приложение показывает «Trust this folder?», ответьте в его штатном диалоге. Изменение продолжится после ответа.'));
      for(const item of sync.conflicts??[]){
        const box=element('div');box.append(element('strong','',item.projectName??'Проект'));
        const field={name:'Название',rootPaths:'Рабочие папки',folder:'Папка',presence:'Наличие проекта'}[item.field]??'Изменение';
        const display=value=>Array.isArray(value)?value.join(' · '):String(value??'корень');
        box.append(element('p','',field+': '+(item.kind==='missing'?'проект отсутствует в '+item.profile:'общее «'+display(item.sharedValue)+'», '+item.profile+' «'+display(item.localValue)+'»')));
        const actions=element('div','cui-dialog-footer');
        const resolve=async choice=>{try{state=await request({type:'resolve-conflict',id:item.id,choice});closeDialog();sharedStatus();}catch(e){notify(e.message)}};
        actions.append(button(item.kind==='missing'?'Восстановить в '+item.profile:'Оставить общее',item.kind==='missing'?'Восстановить':'Оставить общее',()=>resolve('shared')),
          button(item.kind==='missing'?'Удалить для всех':'Принять изменение '+item.profile,item.kind==='missing'?'Удалить для всех':'Принять '+item.profile,()=>resolve('local')));
        box.append(actions);form.append(box);
      }
      if(Object.values(sync.accounts??{}).some(a=>['paused','unsupported'].includes(a.state))){
        form.append(element('p','','Проекты сохранены. Если приложение обновилось, помощник проверит подключение повторно.'));
        form.append(button('Повторить синхронизацию','Повторить',async()=>{try{state=await request({type:'retry-sync'});closeDialog();sharedStatus();}catch(e){notify(e.message)}}));
      }
    },async()=>{},'Готово');
  }
  function dragData(event) {
    try {return JSON.parse(event.dataTransfer.getData('application/x-codex-folder'))}catch{return null}
  }
  function dropTarget(node,parentId) {
    node.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('application/x-codex-folder')){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';node.classList.add('cui-drop')}});
    node.addEventListener('dragleave',event=>{if(!node.contains(event.relatedTarget))node.classList.remove('cui-drop')});
    node.addEventListener('drop',event=>{node.classList.remove('cui-drop');const data=dragData(event);if(!data)return;event.preventDefault();event.stopPropagation();act(data.kind==='folder'?{type:'move',id:data.id,parentId}:{type:'assign',projectKey:data.key,folderId:parentId})});
  }
  function folderRow(folder,depth,order,list) {
    const row=element('div','cui-folder');row.dataset.cuiFolder=folder.id;row.style.setProperty('--cui-depth',depth);row.style.setProperty('--cui-order',order);
    const collapsed=state.collapsedFolderIds.includes(folder.id);
    const toggle=button(pathOf(folder.id),'',()=>act({type:'collapse',id:folder.id,collapsed:!state.collapsedFolderIds.includes(folder.id)}),'cui-folder-toggle');
    toggle.dataset.cuiFolderToggle=folder.id;toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-level',String(depth+1));
    toggle.append(element('span','cui-chevron',collapsed?'›':'⌄'));
    const graphic=element('span');graphic.innerHTML=icon;toggle.append(graphic,element('span','cui-folder-name',folder.name));
    toggle.onkeydown=event=>{
      if(['F2','Insert','Delete','ArrowLeft','ArrowRight'].includes(event.key))event.stopPropagation();
      if(event.key==='F2'){event.preventDefault();renameFolder(folder.id)}
      else if(event.key==='Insert'){event.preventDefault();createFolder(folder.id)}
      else if(event.key==='Delete'){event.preventDefault();removeFolder(folder.id)}
      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();act({type:'collapse',id:folder.id,collapsed:event.key==='ArrowLeft'})}
    };
    row.append(toggle);row.draggable=true;row.ondragstart=e=>{e.stopPropagation();e.dataTransfer.setData('application/x-codex-folder',JSON.stringify({kind:'folder',id:folder.id}));e.dataTransfer.effectAllowed='move'};
    row.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();folderMenu(folder.id,list)};dropTarget(row,folder.id);return row;
  }
  function nativeProject(row,list) {
    let outer=row;while(outer.parentElement&&outer.parentElement!==list)outer=outer.parentElement;
    if(outer.parentElement!==list)return null;
    const container=row.closest('[data-sidebar-project-container-id]');
    const kind=container?.dataset.sidebarProjectKind??'local';
    const key=kind+':'+(container?.dataset.sidebarProjectContainerId??row.dataset.appActionSidebarProjectId);
    return {row,outer,key,id:row.dataset.appActionSidebarProjectId,label:row.dataset.appActionSidebarProjectLabel??''};
  }
  function projectSection(node) {
    const section=node.closest('[data-app-action-sidebar-section]');
    return section&&!section.closest('[data-app-shell-active-page="false"]')&&section.querySelector('[data-app-action-sidebar-project-create]')?section:null;
  }
  function nativePagination(child,list) {
    // The installed Projects list has a final native listitem with one Show more button.
    // Its project-chat pagination controls are inside project items and are not eligible.
    if(child.getAttribute('role')!=='listitem'||child.querySelector('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],[role=list]'))return null;
    const buttons=child.querySelectorAll('button');if(buttons.length!==1)return null;
    const control=buttons[0];if(control.closest('[role=list]')!==list)return null;
    const label=control.textContent.replace(/\s+/g,' ').trim();
    return label==='Show more'||paginationStyles.has(child)&&(control.disabled||control.getAttribute('aria-disabled')==='true')?control:null;
  }
  function restorePagination(node) {
    const saved=paginationStyles.get(node);if(!saved)return;
    if(saved.value)node.style.setProperty('order',saved.value,saved.priority);else node.style.removeProperty('order');
    paginationStyles.delete(node);
  }
  function restoreNative(node) {
    for(const attribute of ['data-cui-project','data-cui-hidden','data-cui-list','data-cui-project-row'])node.removeAttribute(attribute);
    node.style.removeProperty('--cui-depth');node.style.removeProperty('--cui-order');
  }
  function expandProjects(list,items,control) {
    const section=projectSection(list),signature=items.map(item=>item.key).sort().join('\n');
    if(!section||section.dataset.appActionSidebarSectionCollapsed==='true'||control.disabled||control.getAttribute('aria-disabled')==='true'||expansionRequests.get(list)?.signature===signature)return;
    const record={signature,requests:(expansionRequests.get(list)?.requests??0)+1,control};
    expansionRequests.set(list,record);
    queueMicrotask(()=>{
      const footer=control.closest('[role=listitem]');
      if(disposed||expansionRequests.get(list)!==record||!list.isConnected||!control.isConnected||projectSection(list)!==section||section.dataset.appActionSidebarSectionCollapsed==='true'||control.disabled||control.getAttribute('aria-disabled')==='true'||!footer||nativePagination(footer,list)!==control||[...list.children].some(child=>child!==roots.get(list)&&child!==footer&&!items.some(item=>item.outer===child))){
        if(expansionRequests.get(list)===record)expansionRequests.delete(list);schedule();return;
      }
      const focused=document.activeElement;
      // Use the native onExpandedChange/revealAllOnExpand path; never access React internals.
      control.click();
      queueMicrotask(()=>{
        if(disposed)return;
        // Native pagination queues focus onto its list. Keep an active editor's focus.
        const active=document.activeElement;
        if(focused?.isConnected&&(active===list||footer?.contains(active))){if(focused===document.body)active?.blur();else focused.focus({preventScroll:true})}
        schedule();
      });
    });
  }
  function reconcile() {
    timer=null;if(disposed||!document.body)return;
    observer.disconnect();const focused=document.activeElement,focus=focused?.dataset.cuiFolderToggle,focusList=focused?.closest('[role=list]');
    try {
      if(!style.isConnected)document.head.append(style);
      for(const [row,b] of rowButtons)if(!row.isConnected){b.remove();rowButtons.delete(row)}
      for(const [list,root] of roots)if(!list.isConnected){root.remove();roots.delete(list)}
      for(const [section,toolbar] of toolbars)if(!section.isConnected){toolbar.remove();toolbars.delete(section)}
      const projectRanks=new Map((state.projectOrder??[]).map((key,index)=>[key,index]));
      const lists=new Map(),activeLists=new Set(),activeRows=new Set(),activeNative=new Set(),activePagination=new Set(),activeSections=new Set();
      for(const row of document.querySelectorAll('[data-app-action-sidebar-project-row]')) {
        if(!projectSection(row))continue;
        const list=row.closest('[role=list]');if(!list)continue;
        const item=nativeProject(row,list);if(!item)continue;
        const items=lists.get(list)??[];items.push(item);lists.set(list,items);
      }
      for(const create of document.querySelectorAll('[data-app-action-sidebar-project-create]')) {
        const section=projectSection(create);if(!section)continue;activeSections.add(section);
        const heading=section.querySelector('[data-app-action-sidebar-section-toggle]');
        if(heading?.parentElement&&!toolbars.get(section)?.isConnected){
          const bar=element('span','cui-toolbar');bar.dataset.codexUi='toolbar';
          const add=button('Создать корневую папку','',()=>{if(section.dataset.appActionSidebarSectionCollapsed==='true')heading.click();createFolder(null)},'cui-icon-button');add.innerHTML=icon+'<span>+</span>';
          bar.append(add);if(state.sync?.shared)bar.append(button(syncTitle(),'⇄',sharedStatus,'cui-icon-button cui-sync'));dropTarget(bar,null);heading.parentElement.append(bar);toolbars.set(section,bar);
        }
        const syncButton=toolbars.get(section)?.querySelector('.cui-sync');if(syncButton){syncButton.title=syncTitle();syncButton.setAttribute('aria-label',syncTitle());}
        const fallback=fallbacks.get(section);
        if(section.querySelector('[data-app-action-sidebar-project-row]')){fallback?.remove();fallbacks.delete(section)}
        else if(section.dataset.appActionSidebarSectionCollapsed!=='true'){
          const body=section.querySelector(':scope > div > div[aria-hidden]');
          if(body){let list=fallback;if(!list?.isConnected){list=element('div','cui-fallback');list.setAttribute('role','list');body.append(list);fallbacks.set(section,list)}lists.set(list,[])}
        }
      }
      for(const [list,items] of lists) {
        // Never reorder a mixed native pinned list containing unrelated chats.
        const children=[...list.children].filter(child=>child!==roots.get(list));
        const other=children.filter(child=>!items.some(item=>item.outer===child));
        const footer=other.length===1&&other[0]===children.at(-1)?other[0]:null;
        const control=footer&&nativePagination(footer,list);
        if(other.length&&!control)continue;
        activeLists.add(list);list.dataset.cuiList='';nativeNodes.add(list);activeNative.add(list);
        if(control){
          if(!paginationStyles.has(footer))paginationStyles.set(footer,{value:footer.style.getPropertyValue('order'),priority:footer.style.getPropertyPriority('order')});
          footer.style.setProperty('order','2147483647');activePagination.add(footer);expandProjects(list,items,control);
        }
        let root=roots.get(list);if(!root||!root.isConnected){root=element('div','cui-root');root.dataset.codexUi='folders';list.append(root);roots.set(list,root)}
        const fragment=document.createDocumentFragment();let order=0;
        function place(item,depth,hidden) {
          item.outer.dataset.cuiProject=item.key;item.outer.style.setProperty('--cui-order',++order);item.outer.style.setProperty('--cui-depth',depth);
          item.outer.toggleAttribute('data-cui-hidden',hidden);nativeNodes.add(item.outer);activeNative.add(item.outer);
          item.row.dataset.cuiProjectRow='';nativeNodes.add(item.row);activeNative.add(item.row);activeRows.add(item.row);
          let b=rowButtons.get(item.row);if(!b||!b.isConnected||b.dataset.cuiProjectAssign!==item.key){
            b?.remove();
            b=button('Переместить проект в папку','',()=>assignProject(item.key,item.row.dataset.appActionSidebarProjectLabel??item.label),'cui-icon-button cui-assign');b.innerHTML=icon;b.dataset.cuiProjectAssign=item.key;
            b.draggable=true;b.ondragstart=e=>{e.stopPropagation();e.dataTransfer.setData('application/x-codex-folder',JSON.stringify({kind:'project',key:item.key}));e.dataTransfer.effectAllowed='move'};
            item.row.append(b);rowButtons.set(item.row,b);
          }
        }
        function visit(parentId,depth,hidden) {
          for(const folder of sortedFolders(parentId)) {
            const f=folderRow(folder,depth,++order,list);f.toggleAttribute('data-cui-hidden',hidden);fragment.append(f);
            visit(folder.id,depth+1,hidden||state.collapsedFolderIds.includes(folder.id));
          }
          for(const item of items.filter(i=>(state.projectFolderMap[i.key]??null)===parentId).sort((a,b)=>{const ar=projectRanks.get(a.key),br=projectRanks.get(b.key);return ar!==undefined&&br!==undefined?ar-br:parentId?collator.compare(a.label,b.label):0;}))place(item,depth,hidden);
        }
        visit(null,0,false);root.replaceChildren(fragment);
      }
      for(const [list,root] of roots)if(!activeLists.has(list)){root.remove();roots.delete(list)}
      for(const [row,b] of rowButtons)if(!activeRows.has(row)){b.remove();rowButtons.delete(row)}
      for(const node of nativeNodes)if(!activeNative.has(node)){restoreNative(node);nativeNodes.delete(node)}
      for(const node of paginationStyles.keys())if(!activePagination.has(node))restorePagination(node);
      for(const [section,bar] of toolbars)if(!activeSections.has(section)){bar.remove();toolbars.delete(section)}
      for(const [section,list] of fallbacks)if(!activeSections.has(section)){list.remove();fallbacks.delete(section)}
      for(const list of expansionRequests.keys())if(!list.isConnected||!activeLists.has(list))expansionRequests.delete(list);
      if(focus)focusList?.querySelector('[data-cui-folder-toggle="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});
      if(revealProjectId){
        const row=document.querySelector('[data-app-action-sidebar-project-id="'+CSS.escape(revealProjectId)+'"]');
        if(row?.closest('[data-cui-project]')&&!row.closest('[data-cui-hidden]')){row.scrollIntoView({block:'nearest'});revealProjectId=null;}
      }
      renderedRevision=state.revision;
    } catch(error) {console.warn('[codex-folders]',error)}
    finally {if(!disposed)observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-app-action-sidebar-project-collapsed','data-app-action-sidebar-project-label','data-app-action-sidebar-section-collapsed','data-app-shell-active-page','disabled','aria-disabled']})}
  }
  function schedule() {if(!timer&&!disposed)timer=setTimeout(reconcile,50)}
  const observer=new MutationObserver(records=>{
    if(records.some(r=>!r.target.closest?.('.cui-dialog,.cui-toast,.cui-root')&&(r.target.closest?.('[data-app-action-sidebar-section]')||r.attributeName==='data-app-shell-active-page'&&r.target.querySelector?.('[data-app-action-sidebar-section]')||[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches('[data-app-action-sidebar-section]')||n.querySelector('[data-app-action-sidebar-section]'))))))schedule();
  });
  const api={version:1,profile,
    updateState(value){state=value;schedule()},
    resolve(id,result){const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timeout);result.ok?p.resolve(result.state):p.reject(Error(result.error))},
    inspect(){return {profile,revision:state.revision,renderedRevision,creatingIn:creation?.folderId??null,folders:state.folders,projects:[...document.querySelectorAll('[data-cui-project]')].map(e=>({key:e.dataset.cuiProject,hidden:e.hasAttribute('data-cui-hidden'),depth:e.style.getPropertyValue('--cui-depth'),order:e.style.getPropertyValue('--cui-order')})),lists:roots.size,pagination:[...expansionRequests].map(([list,value])=>({requests:value.requests,controlPresent:value.control.isConnected,visibleProjects:list.querySelectorAll('[data-app-action-sidebar-project-row]').length}))}},
    // This local API is also used by regression checks and the CLI; it does not call Codex APIs.
    request,
    dispose(){disposed=true;stopCreation();clearTimeout(timer);clearTimeout(toastTimer);observer.disconnect();closeDialog();style.remove();document.querySelector('.cui-toast')?.remove();for(const root of roots.values())root.remove();for(const bar of toolbars.values())bar.remove();for(const list of fallbacks.values())list.remove();for(const b of rowButtons.values())b.remove();for(const n of nativeNodes)restoreNative(n);for(const n of paginationStyles.keys())restorePagination(n);expansionRequests.clear();for(const p of pending.values()){clearTimeout(p.timeout);p.reject(Error('UI module disconnected'))}pending.clear();if(window.__codexUi===api)delete window.__codexUi}
  };
  window.__codexUi=api;
  if(document.body)reconcile();else document.addEventListener('DOMContentLoaded',reconcile,{once:true});
  return {profile,installed:true};
}
