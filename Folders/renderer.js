// 2026-10-15 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Implement sidebar project folder hierarchy (Folders), context menus, compact panel styling (CSS), and background CDP injection daemon (UI)":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/6
function installCodexFolders(options) {
	window.__codexUi?.dispose();
	const {state: initial, css, profile} = options;
	let state = initial;
	let disposed = false;
	let timer = null;
	let dialog = null;
	let toastTimer = null;
	let renderedRevision = -1;
	let creation = null;
	let revealProjectId = null;
	let contextMenu = null;
	let contextOrigin = null;
	const roots = new Map();
	const pending = new Map();
	const nativeNodes = new Set();
	const toolbars = new Map();
	const fallbacks = new Map();
	const paginationStyles = new Map();
	const expansionRequests = new Map();
	const byId = () => new Map(state.folders.map(f => [f.id, f]));
	const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
	const style = document.createElement('style');
	style.dataset.codexUi = 'style';
	style.textContent = css;
	const icon = '<svg class="cui-folder-icon" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2-2h7a1 1 0 0 1 1 1v12H2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
	function element(tag, className, text) {
		const r = document.createElement(tag);
		if (className) {
			r.className = className;
		}
		if (undefined !== text) {
			r.textContent = text;
		}
		return r;
	}
	function button(label, text, action, className = '') {
		const r = element('button', 'cui-button ' + className, text);
		r.type = 'button';
		r.setAttribute('aria-label', label);
		r.addEventListener('pointerdown', e => e.stopPropagation());
		r.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			action(e);
		});
		return r;
	}
	function request(operation) {
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(Error('No response from the folders module. Reopen shortcut ' + profile));
			}, 10000);
			pending.set(id, {resolve, reject, timeout});
			try {
				window.__codexUiHost(JSON.stringify({id, operation}));
			}
			catch (error) {
				clearTimeout(timeout);
				pending.delete(id);
				reject(error);
			}
		});
	}
	function notify(message) {
		document.querySelector('.cui-toast')?.remove();
		clearTimeout(toastTimer);
		const t = element('div', 'cui-toast', message);
		t.setAttribute('role', 'status');
		document.body.append(t);
		toastTimer = setTimeout(() => t.remove(), 7000);
	}
	function act(operation) {
		return request(operation).catch(error => notify(error.message));
	}
	function pathOf(id) {
		const map = byId();
		const names = [];
		while (id && map.has(id)) {
			const f = map.get(id);
			names.unshift(f.name);
			id = f.parentId;
		}
		return names.join(' / ');
	}
	function descendant(id, parentId) {
		const map = byId();
		let r = false;
		while (parentId && !r) {
			if (id === parentId) {
				r = true;
			}
			else {
				parentId = map.get(parentId)?.parentId;
			}
		}
		return r;
	}
	function sortedFolders(parentId) {
		return state.folders
			.filter(f => f.parentId === parentId)
			.sort((a, b) => collator.compare(a.name, b.name));
	}
	function openDialog(title, build, onSubmit, submitText = 'Save') {
		closeDialog();
		dialog = element('dialog', 'cui-dialog');
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.dataset.state = 'open';
		const form = element('form');
		const h = element('h2', '', title);
		form.append(h);
		const r = build(form);
		if (form.querySelector('.cui-folder-tree')) {
			dialog.classList.add('cui-location-dialog');
		}
		const error = element('div', 'cui-error');
		error.setAttribute('role', 'alert');
		form.append(error);
		const footer = element('div', 'cui-dialog-footer');
		const extra = form.querySelector('.cui-picker-new');
		if (extra) {
			footer.append(extra);
		}
		const cancel = element('button', '', 'Cancel');
		cancel.type = 'button';
		cancel.onclick = closeDialog;
		const save = element('button', '', submitText);
		save.type = 'submit';
		footer.append(cancel, save);
		form.append(footer);
		dialog.append(form);
		form.onsubmit = async event => {
			event.preventDefault();
			save.disabled = true;
			error.textContent = '';
			try {
				await onSubmit(r);
				closeDialog();
			}
			catch (e) {
				error.textContent = e.message;
				save.disabled = false;
			}
		};
		dialog.addEventListener('close', event => {
			const closed = event.currentTarget;
			closed.remove();
			if (dialog === closed) {
				dialog = null;
			}
		});
		document.body.append(dialog);
		dialog.showModal();
		const input = form.querySelector('input:not([type=hidden]),[role=treeitem][tabindex="0"]');
		input?.focus();
		if ('INPUT' === input?.tagName) {
			input.select();
		}
		return r;
	}
	function closeDialog() {
		if (dialog) {
			const old = dialog;
			dialog = null;
			old.close();
			old.remove();
		}
	}
	function inputField(form, label, value = '') {
		const l = element('label', '', label);
		const r = element('input');
		r.value = value;
		r.required = true;
		r.maxLength = 160;
		l.append(r);
		form.append(l);
		return r;
	}
	function folderField(form, current = null, excluded = null) {
		const field = element('div', 'cui-folder-field');
		const label = element('div', 'cui-picker-label', 'Location');
		label.id = 'cui-location-' + crypto.randomUUID();
		const r = element('input', 'cui-folder-value');
		r.type = 'hidden';
		const tree = element('div', 'cui-folder-tree');
		tree.setAttribute('role', 'tree');
		tree.setAttribute('aria-labelledby', label.id);
		const path = element('div', 'cui-picker-path');
		path.setAttribute('aria-live', 'polite');
		const folders = state.folders.filter(folder => !excluded || !descendant(excluded, folder.id));
		const map = new Map(folders.map(folder => [folder.id, folder]));
		const children = new Map();
		const expanded = new Set(folders.map(folder => folder.id));
		const rows = new Map();
		for (const folder of folders) {
			const siblings = children.get(folder.parentId) ?? [];
			siblings.push(folder);
			children.set(folder.parentId, siblings);
		}
		for (const siblings of children.values()) {
			siblings.sort((a, b) => collator.compare(a.name, b.name));
		}
		const initial = map.has(current) ? current : '';
		r.value = initial;
		let focused = initial;
		const parentOf = id => map.get(id)?.parentId ?? '';
		const hasChildren = id => 0 < (children.get(id)?.length ?? 0);
		function focusRow(id) {
			if (rows.has(id)) {
				focused = id;
				for (const [key, row] of rows) {
					row.tabIndex = key === id ? 0 : -1;
				}
				const row = rows.get(id);
				row.focus({preventScroll: true});
				row.scrollIntoView({block: 'nearest'});
			}
		}
		function choose(id) {
			r.value = id;
			focused = id;
			render(true);
			r.dispatchEvent(new Event('change', {bubbles: true}));
		}
		function toggle(id) {
			expanded.has(id) ? expanded.delete(id) : expanded.add(id);
			focused = id;
			render(true);
		}
		function render(restoreFocus = false) {
			const scroll = tree.scrollTop;
			tree.replaceChildren();
			rows.clear();
			function append(id, name, depth, index, count) {
				const row = element('div', 'cui-picker-row');
				row.dataset.folderId = id;
				row.style.setProperty('--cui-picker-depth', depth);
				row.setAttribute('role', 'treeitem');
				row.setAttribute('aria-level', String(depth + 1));
				row.setAttribute('aria-posinset', String(index + 1));
				row.setAttribute('aria-setsize', String(count));
				row.setAttribute('aria-selected', String(id === r.value));
				row.tabIndex = id === focused ? 0 : -1;
				row.setAttribute('aria-label', id ? pathOf(id) : '(Root)');
				if (!hasChildren(id)) {
					row.append(element('span', 'cui-picker-spacer'));
				}
				else {
					row.setAttribute('aria-expanded', String(expanded.has(id)));
					const arrow = element('button', 'cui-picker-toggle', expanded.has(id) ? '⌄' : '›');
					arrow.type = 'button';
					arrow.tabIndex = -1;
					arrow.setAttribute('aria-label', (expanded.has(id) ? 'Collapse' : 'Expand') + ' “' + name + '”');
					arrow.onclick = event => {
						event.preventDefault();
						event.stopPropagation();
						toggle(id);
					};
					row.append(arrow);
				}
				const graphic = element('span', 'cui-picker-icon');
				graphic.innerHTML = icon;
				row.append(graphic, element('span', 'cui-picker-name', name));
				if (id === r.value) {
					const check = element('span', 'cui-picker-check', '✓');
					check.setAttribute('aria-hidden', 'true');
					row.append(check);
				}
				else if (id === initial) {
					row.append(element('span', 'cui-picker-current', 'Current'));
				}
				row.onclick = () => choose(id);
				row.onfocus = () => {
					focused = id;
					for (const [key, item] of rows) {
						item.tabIndex = key === id ? 0 : -1;
					}
				};
				rows.set(id, row);
				tree.append(row);
				if (expanded.has(id)) {
					visit(id, depth + 1);
				}
			}
			function visit(parentId, depth) {
				const siblings = children.get(parentId) ?? [];
				siblings.forEach((folder, index) => append(folder.id, folder.name, depth, index, siblings.length));
			}
			const top = children.get(null) ?? [];
			append('', '(Root)', 0, 0, top.length + 1);
			top.forEach((folder, index) => append(folder.id, folder.name, 0, index + 1, top.length + 1));
			if (!rows.has(focused)) {
				focused = rows.has(r.value) ? r.value : '';
			}
			for (const [id, row] of rows) {
				row.tabIndex = id === focused ? 0 : -1;
			}
			const selectedPath = r.value ? pathOf(r.value) : '(Root)';
			path.textContent = 'Selected: ' + selectedPath;
			tree.scrollTop = scroll;
			if (restoreFocus) {
				focusRow(focused);
			}
		}
		tree.addEventListener('keydown', event => {
			if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
				const row = event.target.closest('[role=treeitem]');
				if (row && tree.contains(row) && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) {
					const id = row.dataset.folderId;
					const ids = [...rows.keys()];
					const index = ids.indexOf(id);
					event.preventDefault();
					event.stopPropagation();
					if ('ArrowDown' === event.key) {
						focusRow(ids[Math.min(index + 1, ids.length - 1)]);
					}
					else if ('ArrowUp' === event.key) {
						focusRow(ids[Math.max(index - 1, 0)]);
					}
					else if ('Home' === event.key) {
						focusRow(ids[0]);
					}
					else if ('End' === event.key) {
						focusRow(ids.at(-1));
					}
					else if ('ArrowRight' === event.key && hasChildren(id)) {
						expanded.has(id) ? focusRow(children.get(id)[0].id) : toggle(id);
					}
					else if ('ArrowLeft' === event.key) {
						if (hasChildren(id) && expanded.has(id)) {
							toggle(id);
						}
						else if (parentOf(id)) {
							focusRow(parentOf(id));
						}
					}
					else if ('Enter' === event.key || ' ' === event.key) {
						choose(id);
					}
				}
			}
		});
		render();
		field.append(label, r, tree, path);
		form.append(field);
		return r;
	}
	function createFolder(parentId = null, projectKey = null) {
		openDialog(
			'New folder',
			form => ({name: inputField(form, 'Name'), parent: folderField(form, parentId)}),
			async fields => {
				const id = crypto.randomUUID();
				await request({type: 'create', id, name: fields.name.value, parentId: fields.parent.value || null});
				if (projectKey) {
					await request({type: 'assign', projectKey, folderId: id});
				}
			},
			'Create'
		);
	}
	function stopCreation(context = creation) {
		if (context) {
			context.observer?.disconnect();
			context.unsubscribe?.();
			clearTimeout(context.timeout);
			if (creation === context) {
				creation = null;
			}
		}
	}
	function createProject(folderId, list) {
		closeDialog();
		stopCreation();
		const native = projectSection(list)?.querySelector('[data-app-action-sidebar-project-create]');
		const service = window.__codexSharedDesktop;
		if (!native || 'function' !== typeof service?.onLocalProjectCreating) {
			notify('Project creation is not connected yet. Try again in a few seconds.');
		}
		else {
			const context = {folderId, dialog: null, previous: new Set(document.querySelectorAll('[role=dialog]'))};
			creation = context;
			const track = () => {
				if (context.dialog) {
					if (!context.dialog.isConnected) {
						stopCreation(context);
					}
				}
				else {
					context.dialog = [...document.querySelectorAll('[role=dialog]')].find(d => !context.previous.has(d) && d.querySelector('form')) ?? null;
					if (context.dialog) {
						clearTimeout(context.timeout);
					}
				}
			};
			context.observer = new MutationObserver(track);
			context.observer.observe(document.body, {childList: true, subtree: true});
			context.unsubscribe = service.onLocalProjectCreating(() => {
				track();
				return creation !== context || !context.dialog?.isConnected
					? null
					: async projectId => {
						stopCreation(context);
						try {
							state = await request({type: 'assign-created-project', projectId, folderId});
							revealProjectId = projectId;
							schedule();
						}
						catch (error) {
							notify('Project created, but could not place it into folder: ' + error.message);
						}
					};
			});
			context.timeout = setTimeout(() => stopCreation(context), 15000);
			native.click();
			track();
		}
	}
	function renameFolder(id) {
		const f = byId().get(id);
		if (f) {
			openDialog('Rename folder', form => inputField(form, 'Name', f.name), field => request({type: 'rename', id, name: field.value}));
		}
	}
	function folderMenu(id, list) {
		const f = byId().get(id);
		if (f) {
			openDialog(
				f.name,
				form => {
					const name = inputField(form, 'Name', f.name);
					const parent = folderField(form, f.parentId, id);
					const actions = element('div', 'cui-dialog-footer');
					const project = element('button', '', 'Create project…');
					project.type = 'button';
					project.onclick = () => createProject(id, list);
					const add = element('button', '', 'Subfolder');
					add.type = 'button';
					add.onclick = () => createFolder(id);
					const remove = element('button', '', 'Delete folder');
					remove.type = 'button';
					remove.onclick = () => removeFolder(id);
					actions.append(project, add, remove);
					form.append(actions);
					return {name, parent};
				},
				async fields => {
					await request({type: 'edit', id, name: fields.name.value, parentId: fields.parent.value || null});
				}
			);
		}
	}
	function removeFolder(id) {
		const f = byId().get(id);
		if (f) {
			openDialog(
				'Delete folder “' + f.name + '”?',
				form => {
					form.append(element('p', '', 'Subfolders and projects will be promoted to the parent. Projects and chats will be preserved.'));
				},
				() => request({type: 'remove', id}),
				'Delete folder'
			);
		}
	}
	function assignProject(projectKey, label, projectId) {
		closeContextMenu();
		openDialog(
			'Folder for project “' + label + '”',
			form => {
				form.classList.add('cui-project-location');
				const r = folderField(form, state.projectFolderMap[projectKey]);
				const add = element('button', 'cui-picker-new', 'New folder…');
				add.type = 'button';
				add.onclick = () => createFolder(r.value || null, projectKey);
				form.append(add);
				return r;
			},
			async select => {
				const folderId = select.value || null;
				state = await request({type: 'assign', projectKey, folderId});
				let folder = byId().get(folderId);
				while (folder) {
					if (state.collapsedFolderIds.includes(folder.id)) {
						state = await request({type: 'collapse', id: folder.id, collapsed: false});
					}
					folder = byId().get(folder.parentId);
				}
				revealProjectId = projectId;
				schedule();
			}
		);
	}
	function closeContextMenu(restoreFocus = false) {
		contextMenu?.remove();
		contextMenu = null;
		if (restoreFocus && contextOrigin?.isConnected) {
			contextOrigin.focus({preventScroll: true});
		}
		contextOrigin = null;
	}
	function projectContextMenu(event) {
		const row = event.target.closest?.('[data-app-action-sidebar-project-row]');
		const list = row?.closest('[role=list]');
		if (row && list && projectSection(row)) {
			const item = nativeProject(row, list);
			if (item) {
				event.preventDefault();
				event.stopImmediatePropagation();
				closeContextMenu();
				contextOrigin = row;
				const menu = contextMenu = element('div', 'cui-context-menu');
				menu.setAttribute('role', 'menu');
				menu.setAttribute('data-state', 'open');
				menu.setAttribute('aria-label', 'Project actions');
				const add = (label, action) => {
					const entry = button(label, label, () => {
						closeContextMenu();
						action();
					}, 'cui-context-item');
					entry.setAttribute('role', 'menuitem');
					menu.append(entry);
				};
				add('Move to folder…', () => assignProject(item.key, item.row.dataset.appActionSidebarProjectLabel ?? item.label, item.id));
				const nativeButtons = [...row.querySelectorAll('button')];
				const start = nativeButtons.find(button => button.getAttribute('aria-label')?.startsWith('Start new chat in '));
				if (start) {
					add('New chat', () => start.click());
				}
				// 2026-10-31 Dmitrii Fediuk https://github.com/dmitrii-fediuk
				// "Fix \"More project actions…\" context menu item by dispatching pointerdown and preserving trigger layout box":
				// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/17
				const native = nativeButtons.find(button => 'menu' === button.getAttribute('aria-haspopup'));
				if (native) {
					add('More project actions…', () => native.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0, ctrlKey: false, pointerType: 'mouse', clientX: event.clientX, clientY: event.clientY})));
				}
				menu.addEventListener('keydown', event => {
					const entries = [...menu.querySelectorAll('[role=menuitem]')];
					const index = entries.indexOf(document.activeElement);
					if ('ArrowDown' === event.key || 'ArrowUp' === event.key) {
						event.preventDefault();
						event.stopPropagation();
						entries[(index + ('ArrowDown' === event.key ? 1 : -1) + entries.length) % entries.length]?.focus();
					}
				});
				document.body.append(menu);
				menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)) + 'px';
				menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)) + 'px';
				menu.querySelector('[role=menuitem]')?.focus({preventScroll: true});
			}
		}
	}
	function dismissContextMenu(event) {
		if (contextMenu && !contextMenu.contains(event.target)) {
			closeContextMenu();
		}
	}
	function contextMenuKey(event) {
		if ('Escape' === event.key && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
			if (contextMenu) {
				event.preventDefault();
				event.stopImmediatePropagation();
				closeContextMenu(true);
			}
			else if (dialog) {
				event.preventDefault();
				event.stopImmediatePropagation();
				closeDialog();
			}
			else if (!event.target.closest?.('.xterm,.monaco-editor,.cm-editor,input')) {
				const popup = [...document.querySelectorAll('dialog[open],[role=dialog][data-state=open]:not([aria-modal=false]),[role=menu][data-state=open],[role=listbox][data-state=open]')].some(el => {
					const style = getComputedStyle(el);
					const rect = el.getBoundingClientRect();
					return !el.hasAttribute('data-closed') && 'none' !== style.display && 'hidden' !== style.visibility && 0 < Number(style.opacity) && 0 < rect.width && 0 < rect.height;
				});
				if (!popup) {
					event.preventDefault();
					event.stopImmediatePropagation();
					Promise.resolve(window.electronBridge?.showContextMenu?.([])).catch(() => {});
				}
			}
		}
	}
	const contextBlur = () => closeContextMenu();
	document.addEventListener('contextmenu', projectContextMenu, true);
	document.addEventListener('pointerdown', dismissContextMenu, true);
	window.addEventListener('keydown', contextMenuKey, true);
	window.addEventListener('blur', contextBlur);
	function syncTitle() {
		const sync = state.sync;
		let r = '';
		if (sync?.shared) {
			const accounts = Object.entries(sync.accounts ?? {});
			if (sync.conflicts?.length) {
				r = 'Shared projects: action required to resolve changes';
			}
			else if (accounts.some(([, a]) => ['paused', 'unsupported'].includes(a.state))) {
				r = 'Shared projects: synchronization paused';
			}
			else if (accounts.some(([, a]) => 'waiting' === a.state)) {
				r = 'Shared projects: waiting for app response';
			}
			else if (accounts.some(([, a]) => 0 < a.pending)) {
				r = 'Shared projects: pending changes';
			}
			else {
				r = 'Shared projects: synchronized';
			}
		}
		return r;
	}
	function sharedStatus() {
		const sync = state.sync;
		if (sync?.shared) {
			openDialog(
				'Shared projects',
				form => {
					form.append(element('p', '', syncTitle().replace('Shared projects: ', '')));
					for (const [id, account] of Object.entries(sync.accounts ?? {})) {
						const label = 'offline' === account.state
							? 'offline'
							: 'connected' === account.state
								? 'connected'
								: 'waiting' === account.state
									? 'waiting for app response'
									: 'paused';
						form.append(element('p', '', id + ' — ' + label + (account.pending ? ' · pending changes: ' + account.pending : '')));
						if (account.error) {
							form.append(element('p', 'cui-error', account.error));
						}
					}
					if (Object.values(sync.accounts ?? {}).some(a => 'waiting' === a.state)) {
						form.append(element('p', '', 'If the app shows “Trust this folder?”, respond in its native dialog. The change will continue after your response.'));
					}
					for (const item of sync.conflicts ?? []) {
						const box = element('div');
						box.append(element('strong', '', item.projectName ?? 'Project'));
						const field = {name: 'Name', rootPaths: 'Working folders', folder: 'Folder', presence: 'Project presence'}[item.field] ?? 'Change';
						const display = value => Array.isArray(value) ? value.join(' · ') : String(value ?? 'root');
						box.append(element('p', '', field + ': ' + ('missing' === item.kind ? 'project is missing in ' + item.profile : 'shared “' + display(item.sharedValue) + '”, ' + item.profile + ' “' + display(item.localValue) + '”')));
						const actions = element('div', 'cui-dialog-footer');
						const resolve = async choice => {
							try {
								state = await request({type: 'resolve-conflict', id: item.id, choice});
								closeDialog();
								sharedStatus();
							}
							catch (e) {
								notify(e.message);
							}
						};
						actions.append(
							button('missing' === item.kind ? 'Restore in ' + item.profile : 'Keep shared', 'missing' === item.kind ? 'Restore' : 'Keep shared', () => resolve('shared')),
							button('missing' === item.kind ? 'Delete for all' : 'Accept change from ' + item.profile, 'missing' === item.kind ? 'Delete for all' : 'Accept ' + item.profile, () => resolve('local'))
						);
						box.append(actions);
						form.append(box);
					}
					if (Object.values(sync.accounts ?? {}).some(a => ['paused', 'unsupported'].includes(a.state))) {
						form.append(element('p', '', 'Projects are preserved. If the app was updated, the companion will recheck the connection.'));
						form.append(button('Retry synchronization', 'Retry', async () => {
							try {
								state = await request({type: 'retry-sync'});
								closeDialog();
								sharedStatus();
							}
							catch (e) {
								notify(e.message);
							}
						}));
					}
				},
				async () => {},
				'Done'
			);
		}
	}
	function dragData(event) {
		let r = null;
		try {
			r = JSON.parse(event.dataTransfer.getData('application/x-codex-folder'));
		}
		catch {}
		return r;
	}
	function dropTarget(node, parentId) {
		node.addEventListener('dragover', event => {
			if (event.dataTransfer.types.includes('application/x-codex-folder')) {
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = 'move';
				node.classList.add('cui-drop');
			}
		});
		node.addEventListener('dragleave', event => {
			if (!node.contains(event.relatedTarget)) {
				node.classList.remove('cui-drop');
			}
		});
		node.addEventListener('drop', event => {
			node.classList.remove('cui-drop');
			const data = dragData(event);
			if (data) {
				event.preventDefault();
				event.stopPropagation();
				act('folder' === data.kind ? {type: 'move', id: data.id, parentId} : {type: 'assign', projectKey: data.key, folderId: parentId});
			}
		});
	}
	function folderRow(folder, depth, order, list) {
		const r = element('div', 'cui-folder');
		r.dataset.cuiFolder = folder.id;
		r.style.setProperty('--cui-depth', depth);
		r.style.setProperty('--cui-order', order);
		const collapsed = state.collapsedFolderIds.includes(folder.id);
		const toggle = button(pathOf(folder.id), '', () => act({type: 'collapse', id: folder.id, collapsed: !state.collapsedFolderIds.includes(folder.id)}), 'cui-folder-toggle');
		toggle.dataset.cuiFolderToggle = folder.id;
		toggle.setAttribute('aria-expanded', String(!collapsed));
		toggle.setAttribute('aria-level', String(depth + 1));
		toggle.append(element('span', 'cui-chevron', collapsed ? '›' : '⌄'));
		const graphic = element('span');
		graphic.innerHTML = icon;
		toggle.append(graphic, element('span', 'cui-folder-name', folder.name));
		toggle.onkeydown = event => {
			if (['F2', 'Insert', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
				event.stopPropagation();
			}
			if ('F2' === event.key) {
				event.preventDefault();
				renameFolder(folder.id);
			}
			else if ('Insert' === event.key) {
				event.preventDefault();
				createFolder(folder.id);
			}
			else if ('Delete' === event.key) {
				event.preventDefault();
				removeFolder(folder.id);
			}
			else if ('ArrowLeft' === event.key || 'ArrowRight' === event.key) {
				event.preventDefault();
				act({type: 'collapse', id: folder.id, collapsed: 'ArrowLeft' === event.key});
			}
		};
		r.append(toggle);
		r.draggable = true;
		r.ondragstart = e => {
			e.stopPropagation();
			e.dataTransfer.setData('application/x-codex-folder', JSON.stringify({kind: 'folder', id: folder.id}));
			e.dataTransfer.effectAllowed = 'move';
		};
		r.oncontextmenu = e => {
			e.preventDefault();
			e.stopPropagation();
			folderMenu(folder.id, list);
		};
		dropTarget(r, folder.id);
		return r;
	}
	function nativeProject(row, list) {
		let outer = row;
		while (outer.parentElement && outer.parentElement !== list) {
			outer = outer.parentElement;
		}
		let r = null;
		if (outer.parentElement === list) {
			const container = row.closest('[data-sidebar-project-container-id]');
			const kind = container?.dataset.sidebarProjectKind ?? 'local';
			const key = kind + ':' + (container?.dataset.sidebarProjectContainerId ?? row.dataset.appActionSidebarProjectId);
			r = {row, outer, key, id: row.dataset.appActionSidebarProjectId, label: row.dataset.appActionSidebarProjectLabel ?? ''};
		}
		return r;
	}
	function projectSection(node) {
		const section = node.closest('[data-app-action-sidebar-section]');
		return section && !section.closest('[data-app-shell-active-page="false"]') && section.querySelector('[data-app-action-sidebar-project-create]') ? section : null;
	}
	function nativePagination(child, list) {
		let r = null;
		if ('listitem' === child.getAttribute('role') && !child.querySelector('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],[role=list]')) {
			const buttons = child.querySelectorAll('button');
			if (1 === buttons.length) {
				const control = buttons[0];
				if (control.closest('[role=list]') === list) {
					const label = control.textContent.replace(/\s+/g, ' ').trim();
					if ('Show more' === label || (paginationStyles.has(child) && (control.disabled || 'true' === control.getAttribute('aria-disabled')))) {
						r = control;
					}
				}
			}
		}
		return r;
	}
	function restorePagination(node) {
		const saved = paginationStyles.get(node);
		if (saved) {
			if (saved.value) {
				node.style.setProperty('order', saved.value, saved.priority);
			}
			else {
				node.style.removeProperty('order');
			}
			paginationStyles.delete(node);
		}
	}
	function restoreNative(node) {
		for (const attribute of ['data-cui-project', 'data-cui-hidden', 'data-cui-list', 'data-cui-project-row']) {
			node.removeAttribute(attribute);
		}
		node.style.removeProperty('--cui-depth');
		node.style.removeProperty('--cui-order');
	}
	function expandProjects(list, items, control) {
		const section = projectSection(list);
		const signature = items.map(item => item.key).sort().join('\n');
		if (
			section &&
			'true' !== section.dataset.appActionSidebarSectionCollapsed &&
			!control.disabled &&
			'true' !== control.getAttribute('aria-disabled') &&
			expansionRequests.get(list)?.signature !== signature
		) {
			const record = {signature, requests: (expansionRequests.get(list)?.requests ?? 0) + 1, control};
			expansionRequests.set(list, record);
			queueMicrotask(() => {
				const footer = control.closest('[role=listitem]');
				if (
					disposed ||
					expansionRequests.get(list) !== record ||
					!list.isConnected ||
					!control.isConnected ||
					projectSection(list) !== section ||
					'true' === section.dataset.appActionSidebarSectionCollapsed ||
					control.disabled ||
					'true' === control.getAttribute('aria-disabled') ||
					!footer ||
					nativePagination(footer, list) !== control ||
					[...list.children].some(child => child !== roots.get(list) && child !== footer && !items.some(item => item.outer === child))
				) {
					if (expansionRequests.get(list) === record) {
						expansionRequests.delete(list);
					}
					schedule();
				}
				else {
					const focused = document.activeElement;
					control.click();
					queueMicrotask(() => {
						if (!disposed) {
							const active = document.activeElement;
							if (focused?.isConnected && (active === list || footer?.contains(active))) {
								if (focused === document.body) {
									active?.blur();
								}
								else {
									focused.focus({preventScroll: true});
								}
							}
							schedule();
						}
					});
				}
			});
		}
	}
	function reconcile() {
		timer = null;
		if (!disposed && document.body) {
			observer.disconnect();
			const focused = document.activeElement;
			const focus = focused?.dataset.cuiFolderToggle;
			const focusList = focused?.closest('[role=list]');
			try {
				if (!style.isConnected) {
					document.head.append(style);
				}
				for (const [list, root] of roots) {
					if (!list.isConnected) {
						root.remove();
						roots.delete(list);
					}
				}
				for (const [section, toolbar] of toolbars) {
					if (!section.isConnected) {
						toolbar.remove();
						toolbars.delete(section);
					}
				}
				const projectRanks = new Map((state.projectOrder ?? []).map((key, index) => [key, index]));
				const lists = new Map();
				const activeLists = new Set();
				const activeRows = new Set();
				const activeNative = new Set();
				const activePagination = new Set();
				const activeSections = new Set();
				for (const row of document.querySelectorAll('[data-app-action-sidebar-project-row]')) {
					if (projectSection(row)) {
						const list = row.closest('[role=list]');
						if (list) {
							const item = nativeProject(row, list);
							if (item) {
								const items = lists.get(list) ?? [];
								items.push(item);
								lists.set(list, items);
							}
						}
					}
				}
				for (const create of document.querySelectorAll('[data-app-action-sidebar-project-create]')) {
					const section = projectSection(create);
					if (section) {
						activeSections.add(section);
						const heading = section.querySelector('[data-app-action-sidebar-section-toggle]');
						if (heading?.parentElement && !toolbars.get(section)?.isConnected) {
							const bar = element('span', 'cui-toolbar');
							bar.dataset.codexUi = 'toolbar';
							const add = button('Create root folder', '', () => {
								if ('true' === section.dataset.appActionSidebarSectionCollapsed) {
									heading.click();
								}
								createFolder(null);
							}, 'cui-icon-button');
							add.innerHTML = icon + '<span>+</span>';
							bar.append(add);
							if (state.sync?.shared) {
								bar.append(button(syncTitle(), '⇄', sharedStatus, 'cui-icon-button cui-sync'));
							}
							dropTarget(bar, null);
							heading.parentElement.append(bar);
							toolbars.set(section, bar);
						}
						const syncButton = toolbars.get(section)?.querySelector('.cui-sync');
						if (syncButton) {
							syncButton.setAttribute('aria-label', syncTitle());
						}
						const fallback = fallbacks.get(section);
						if (section.querySelector('[data-app-action-sidebar-project-row]')) {
							fallback?.remove();
							fallbacks.delete(section);
						}
						else if ('true' !== section.dataset.appActionSidebarSectionCollapsed) {
							const body = section.querySelector(':scope > div > div[aria-hidden]');
							if (body) {
								let list = fallback;
								if (!list?.isConnected) {
									list = element('div', 'cui-fallback');
									list.setAttribute('role', 'list');
									body.append(list);
									fallbacks.set(section, list);
								}
								lists.set(list, []);
							}
						}
					}
				}
				for (const [list, items] of lists) {
					const children = [...list.children].filter(child => child !== roots.get(list));
					const other = children.filter(child => !items.some(item => item.outer === child));
					const footer = 1 === other.length && other[0] === children.at(-1) ? other[0] : null;
					const control = footer && nativePagination(footer, list);
					if (!other.length || control) {
						activeLists.add(list);
						list.dataset.cuiList = '';
						nativeNodes.add(list);
						activeNative.add(list);
						if (control) {
							if (!paginationStyles.has(footer)) {
								paginationStyles.set(footer, {value: footer.style.getPropertyValue('order'), priority: footer.style.getPropertyPriority('order')});
							}
							footer.style.setProperty('order', '2147483647');
							activePagination.add(footer);
							expandProjects(list, items, control);
						}
						let root = roots.get(list);
						if (!root || !root.isConnected) {
							root = element('div', 'cui-root');
							root.dataset.codexUi = 'folders';
							list.append(root);
							roots.set(list, root);
						}
						const fragment = document.createDocumentFragment();
						let order = 0;
						function place(item, depth, hidden) {
							item.outer.dataset.cuiProject = item.key;
							item.outer.style.setProperty('--cui-order', ++order);
							item.outer.style.setProperty('--cui-depth', depth);
							item.outer.toggleAttribute('data-cui-hidden', hidden);
							nativeNodes.add(item.outer);
							activeNative.add(item.outer);
							item.row.dataset.cuiProjectRow = '';
							nativeNodes.add(item.row);
							activeNative.add(item.row);
							activeRows.add(item.row);
						}
						function visit(parentId, depth, hidden) {
							for (const folder of sortedFolders(parentId)) {
								const f = folderRow(folder, depth, ++order, list);
								f.toggleAttribute('data-cui-hidden', hidden);
								fragment.append(f);
								visit(folder.id, depth + 1, hidden || state.collapsedFolderIds.includes(folder.id));
							}
							for (const item of items.filter(i => (state.projectFolderMap[i.key] ?? null) === parentId).sort((a, b) => {
								const ar = projectRanks.get(a.key);
								const br = projectRanks.get(b.key);
								return undefined !== ar && undefined !== br ? ar - br : parentId ? collator.compare(a.label, b.label) : 0;
							})) {
								place(item, depth, hidden);
							}
						}
						visit(null, 0, false);
						root.replaceChildren(fragment);
					}
				}
				for (const [list, root] of roots) {
					if (!activeLists.has(list)) {
						root.remove();
						roots.delete(list);
					}
				}
				for (const node of nativeNodes) {
					if (!activeNative.has(node)) {
						restoreNative(node);
						nativeNodes.delete(node);
					}
				}
				for (const node of paginationStyles.keys()) {
					if (!activePagination.has(node)) {
						restorePagination(node);
					}
				}
				for (const [section, bar] of toolbars) {
					if (!activeSections.has(section)) {
						bar.remove();
						toolbars.delete(section);
					}
				}
				for (const [section, list] of fallbacks) {
					if (!activeSections.has(section)) {
						list.remove();
						fallbacks.delete(section);
					}
				}
				for (const list of expansionRequests.keys()) {
					if (!list.isConnected || !activeLists.has(list)) {
						expansionRequests.delete(list);
					}
				}
				if (focus) {
					focusList?.querySelector('[data-cui-folder-toggle="' + CSS.escape(focus) + '"]')?.focus({preventScroll: true});
				}
				if (revealProjectId) {
					const row = document.querySelector('[data-app-action-sidebar-project-id="' + CSS.escape(revealProjectId) + '"]');
					if (row?.closest('[data-cui-project]') && !row.closest('[data-cui-hidden]')) {
						row.scrollIntoView({block: 'nearest'});
						revealProjectId = null;
					}
				}
				renderedRevision = state.revision;
			}
			catch (error) {
				console.warn('[codex-folders]', error);
			}
			finally {
				if (!disposed) {
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ['data-app-action-sidebar-project-collapsed', 'data-app-action-sidebar-project-label', 'data-app-action-sidebar-section-collapsed', 'data-app-shell-active-page', 'disabled', 'aria-disabled']
					});
				}
			}
		}
	}
	function schedule() {
		if (!timer && !disposed) {
			timer = setTimeout(reconcile, 50);
		}
	}
	const observer = new MutationObserver(records => {
		if (records.some(r => !r.target.closest?.('.cui-dialog,.cui-toast,.cui-root') && (
			r.target.closest?.('[data-app-action-sidebar-section]') ||
			('data-app-shell-active-page' === r.attributeName && r.target.querySelector?.('[data-app-action-sidebar-section]')) ||
			[...r.addedNodes, ...r.removedNodes].some(n => 1 === n.nodeType && (n.matches('[data-app-action-sidebar-section]') || n.querySelector('[data-app-action-sidebar-section]')))
		))) {
			schedule();
		}
	});
	const api = {
		version: 1,
		profile,
		handleEscape: contextMenuKey,
		updateState(value) {
			state = value;
			schedule();
		},
		resolve(id, result) {
			const p = pending.get(id);
			if (p) {
				pending.delete(id);
				clearTimeout(p.timeout);
				result.ok ? p.resolve(result.state) : p.reject(Error(result.error));
			}
		},
		inspect() {
			return {
				profile,
				revision: state.revision,
				renderedRevision,
				escapeStopsChat: false,
				creatingIn: creation?.folderId ?? null,
				folders: state.folders,
				projectFolderMap: state.projectFolderMap,
				projects: [...document.querySelectorAll('[data-cui-project]')].map(e => ({
					key: e.dataset.cuiProject,
					hidden: e.hasAttribute('data-cui-hidden'),
					depth: e.style.getPropertyValue('--cui-depth'),
					order: e.style.getPropertyValue('--cui-order')
				})),
				lists: roots.size,
				pagination: [...expansionRequests].map(([list, value]) => ({
					requests: value.requests,
					controlPresent: value.control.isConnected,
					visibleProjects: list.querySelectorAll('[data-app-action-sidebar-project-row]').length
				}))
			};
		},
		request,
		dispose() {
			disposed = true;
			stopCreation();
			closeContextMenu();
			document.removeEventListener('contextmenu', projectContextMenu, true);
			document.removeEventListener('pointerdown', dismissContextMenu, true);
			window.removeEventListener('keydown', contextMenuKey, true);
			window.removeEventListener('blur', contextBlur);
			clearTimeout(timer);
			clearTimeout(toastTimer);
			observer.disconnect();
			closeDialog();
			style.remove();
			document.querySelector('.cui-toast')?.remove();
			for (const root of roots.values()) {
				root.remove();
			}
			for (const bar of toolbars.values()) {
				bar.remove();
			}
			for (const list of fallbacks.values()) {
				list.remove();
			}
			for (const n of nativeNodes) {
				restoreNative(n);
			}
			for (const n of paginationStyles.keys()) {
				restorePagination(n);
			}
			expansionRequests.clear();
			for (const p of pending.values()) {
				clearTimeout(p.timeout);
				p.reject(Error('UI module disconnected'));
			}
			pending.clear();
			if (window.__codexUi === api) {
				delete window.__codexUi;
			}
		}
	};
	window.__codexUi = api;
	if (document.body) {
		reconcile();
	}
	else {
		document.addEventListener('DOMContentLoaded', reconcile, {once: true});
	}
	return {profile, installed: true};
}
