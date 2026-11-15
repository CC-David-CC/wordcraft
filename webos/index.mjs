/** Same-origin view of the actual WordCraft engine, with server-authoritative file bindings. */
import './style.css';
const MAX_FILE = 128 * 1024 * 1024;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.startsWith('.') && !/[\/\\\0]/.test(name);
const base64 = bytes => { const parts = []; for (let i = 0; i < bytes.length; i += 24576) { let text = ''; for (const value of bytes.subarray(i, i + 24576)) text += String.fromCharCode(value); parts.push(btoa(text)); } return parts.join(''); };

export function mount({instanceId, sessionId, resource = null, files, authority, authorize, displayName = '', url, signal: parentSignal}) {
  if (!instanceId || !sessionId || !files || typeof authorize !== 'function') throw TypeError('WordCraft requires explicit instance/session identity, Storage and authorization.');
  const source = new URL(url, location.href); if (source.origin !== location.origin) throw Error('This WordCraft integration requires same-origin trusted code.');
  source.searchParams.set('host', 'parent'); source.searchParams.set('author', displayName);
  const element = document.createElement('div'), frame = document.createElement('iframe'), status = document.createElement('div');
  element.className = 'webos-wordcraft'; frame.title = 'WordCraft document'; frame.allow = 'clipboard-read; clipboard-write'; status.className = 'webos-wordcraft-status'; status.setAttribute('role', 'status');
  element.append(frame, status);
  const abort = new AbortController(), bindings = new Map(), completions = new Map(), pendingDocuments = new Set();
  let disposed = false, phase = 'loading', dirty = false, currentDocument = null, publicDocuments = [], readyResolve, readyReject, initializing = false, closeDialog = null;
  const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject}); ready.catch(() => {});
  const check = () => { if (disposed || abort.signal.aborted) throw new DOMException('Editor view closed.', 'AbortError'); files.check(); };
  const api = () => { check(); const value = frame.contentWindow?.wordcraft; if (!value || typeof value.request !== 'function') throw Error('WordCraft command interface unavailable.'); return value; };
  const target = () => ({instanceId, sessionId, documentId: currentDocument, resourceId: bindings.get(currentDocument)?.path || (currentDocument ? 'draft:' + currentDocument : null)});
  const inspect = () => ({...target(), phase, disposed, dirty, pendingSaves: pendingDocuments.size,
    documents: structuredClone(publicDocuments), files: [...bindings.entries()].map(([documentId, binding]) => ({documentId, ...binding}))});
  async function refresh() {
    const value = await api().uiInspect(); check(); if (!Array.isArray(value.documentStates) || !Array.isArray(value.unsavedDocuments) || !Number.isSafeInteger(value.pendingSaves)) throw Error('WordCraft host-completion inspection contract is unavailable.'); currentDocument = String(value.document); dirty = value.dirty === true;
    publicDocuments = value.documents || []; return value;
  }
  function reply(type, fields) { if (!disposed) frame.contentWindow.postMessage({type, ...fields}, location.origin); }
  function completion(id) {
    if (!completions.has(id)) { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); promise.catch(() => {}); completions.set(id, {promise, resolve, reject}); }
    return completions.get(id);
  }
  async function save(message) {
    const id = message.id, documentId = message.documentId;
    if (typeof id !== 'string' || !/^wordcraft-save-[0-9]+$/.test(id)) { status.textContent = 'Refused a save without its completion identity.'; return; }
    const done = completion(id); if (done.started) return; done.started = true;
    let admitted = false;
    try {
      check();
      if (typeof documentId !== 'string' || !/^[0-9]+$/.test(documentId) || typeof message.revision !== 'string' || !/^[0-9]+$/.test(message.revision) || !validName(message.name) || !(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength > MAX_FILE || typeof message.saveAs !== 'boolean' || typeof message.documentSave !== 'boolean' || !['file.save', 'file.saveAs', 'file.exportPdf', 'file.exportPng'].includes(message.operation)) throw Error('Invalid identified WordCraft save.');
      if (await authorize(authority, {instanceId, sessionId, documentId, operation: message.operation, resourceId: bindings.get(documentId)?.path || 'draft:' + documentId}) !== true) throw Error('Save is not authorized.');
      check(); if (pendingDocuments.has(documentId)) throw Error('Another save is already pending for this document.');
      pendingDocuments.add(documentId); admitted = true; status.textContent = 'Saving to your account…';
      const original = bindings.get(documentId), sameSource = message.operation === 'file.save' && !message.saveAs && original && original.path.split('/').at(-1) === message.name;
      const directory = original ? (original.path.includes('/') ? original.path.slice(0, original.path.lastIndexOf('/')) : '') : 'Documents';
      const destination = sameSource ? original.path : (directory ? directory + '/' : '') + message.name;
      const saved = await files.write(destination, new Blob([message.bytes]), sameSource ? original.sha256 : null, {signal: abort.signal}); check();
      if (!/^[0-9a-f]{64}$/.test(saved?.sha256 || '')) throw Error('Server save confirmation is invalid.');
      if (sameSource || (message.documentSave && (message.saveAs || !original))) bindings.set(documentId, {path: destination, sha256: saved.sha256});
      status.textContent = 'Saved to your account: ' + destination;
      reply('wordcraft:saved', {id}); done.resolve({status: 'saved', path: destination, sha256: saved.sha256, committed: true});
    } catch (error) {
      if (!disposed) { status.textContent = error.message + (error.outcome === 'unknown' ? ' The server outcome is unknown; check the file before retrying.' : ''); reply('wordcraft:save-failed', {id, error: status.textContent}); }
      done.reject(error);
    } finally { if (admitted) pendingDocuments.delete(documentId); }
  }
  function startupFailed(error) {
    if (disposed) return; phase = 'failed'; status.textContent = error.message; clearTimeout(startup); readyReject(error);
    abort.abort(); frame.src = 'about:blank'; frame.remove();
  }
  async function initialize() {
    if (initializing || disposed) return; initializing = true;
    try {
      check();
      if (resource) {
        if (typeof resource.path !== 'string' || resource.path.startsWith('/') || resource.path.split('/').some(part => !validName(part)) || !/^[0-9a-f]{64}$/.test(resource.sha256 || '')) throw Error('An exact account file identity and revision are required.');
        const opened = await files.read(resource.path); check(); if (opened.sha256 !== resource.sha256) throw Error('This file changed before opening. Refresh Files and open it again.');
        const result = await api().request('engine.execute', {command: 'file.open', params: {path: resource.path.split('/').at(-1), data: base64(opened.data)}}); check();
        if (!Number.isSafeInteger(result.id)) throw Error('WordCraft did not identify the opened document.');
        bindings.set(String(result.id), {path: resource.path, sha256: opened.sha256});
      }
      else { await api().request('engine.execute', {command: 'file.new', params: {}}); check(); }
      await refresh(); phase = 'ready'; status.textContent = resource ? 'Opened account file: ' + resource.path : 'New document; not saved to your account.'; clearTimeout(startup); readyResolve();
    } catch (error) { startupFailed(error); }
  }
  function message(event) {
    if (disposed || event.origin !== location.origin || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'wordcraft:ready') initialize();
    if (event.data.type === 'wordcraft:save') save(event.data);
    if (event.data.type === 'wordcraft:dirty') dirty = event.data.dirty === true;
    if (event.data.type === 'wordcraft:failed') startupFailed(Error(String(event.data.error || 'WordCraft failed to start.')));
  }
  window.addEventListener('message', message, {signal: abort.signal});
  const startup = setTimeout(() => { if (phase === 'loading' && !disposed) startupFailed(Error('WordCraft startup timed out.')); }, 120000);
  async function execute(request, candidate = authority) {
    await ready; check();
    if (!request || request.instanceId !== instanceId || request.sessionId !== sessionId || typeof request.documentId !== 'string' || !/^[0-9]+$/.test(request.documentId)) throw Error('Exact editor instance, session and document target required.');
    const binding = bindings.get(request.documentId), resourceId = binding?.path || 'draft:' + request.documentId;
    if (request.resourceId !== resourceId || await authorize(candidate, {instanceId, sessionId, documentId: request.documentId, resourceId, operation: request.command}) !== true) throw Error('Document operation is unavailable or denied.');
    check(); const rawArgs = JSON.stringify(request.args || {}); if (rawArgs.length > 65536) throw Error('Command arguments exceed the bounded metadata contract.'); const args = JSON.parse(rawArgs), doc = Number(request.documentId); if (!Number.isSafeInteger(doc)) throw Error('Invalid document identity.');
    const result = request.command === 'document.inspect' ? await api().request('document.inspect', {...args, doc})
      : await api().request('engine.execute', {command: request.command, params: args, doc});
    check();
    if (result?.pendingSave) { const saved = await completion('wordcraft-save-' + result.pendingSave).promise; check(); await refresh(); return saved; }
    await refresh(); return result;
  }
  function askClose() {
    const dialog = document.createElement('dialog'); closeDialog = dialog; dialog.className = 'webos-wordcraft-close';
    const title = document.createElement('h2'); title.textContent = 'Save changes before closing WordCraft?'; dialog.append(title);
    return new Promise(resolve => {
      const finish = choice => { if (closeDialog !== dialog) return; closeDialog = null; abort.signal.removeEventListener('abort', cancelled); dialog.close(); dialog.remove(); resolve(choice); };
      const cancelled = () => finish('cancel'); abort.signal.addEventListener('abort', cancelled, {once: true});
      for (const [choice, label] of [['save', 'Save'], ['discard', 'Discard changes'], ['cancel', 'Cancel']]) { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', () => finish(choice)); dialog.append(b); }
      dialog.addEventListener('cancel', event => {event.preventDefault(); finish('cancel')}); document.body.append(dialog); dialog.showModal(); dialog.lastElementChild.focus();
    });
  }
  async function requestClose() {
    if (phase !== 'ready') return pendingDocuments.size === 0;
    const before = await refresh(); if (pendingDocuments.size || before.pendingSaves) {status.textContent = 'Wait for the current save result before closing.'; return false;}
    const unsaved = (before.unsavedDocuments || before.documents.filter(doc => doc.dirty).map(doc => doc.id)).map(String);
    if (!unsaved.length && !before.dirty) return true;
    const choice = await askClose(); check(); if (choice === 'cancel') return false; if (choice === 'discard') { const after = await refresh(); if (JSON.stringify(before.documentStates) !== JSON.stringify(after.documentStates)) { status.textContent = 'Documents changed while confirming. Review them before closing.'; return false; } return true; }
    try {
      for (const documentId of unsaved.length ? unsaved : [String(before.document)]) {
        await execute({instanceId, sessionId, documentId, resourceId: bindings.get(documentId)?.path || 'draft:' + documentId, command: 'file.save'});
      }
      const after = await refresh(); return !after.dirty && !after.pendingSaves && !(after.unsavedDocuments || after.documents.filter(doc => doc.dirty)).length;
    } catch (error) { if (!disposed) status.textContent = 'The editor stays open: ' + error.message; return false; }
  }
  function dispose() {
    if (disposed) return; disposed = true; phase = 'disposed'; parentSignal?.removeEventListener('abort', dispose); clearTimeout(startup); abort.abort();
    readyReject(new DOMException('Editor view closed.', 'AbortError')); for (const done of completions.values()) done.reject(new DOMException('Editor view closed; verify any pending save before retrying.', 'AbortError'));
    frame.src = 'about:blank'; frame.remove(); element.remove(); bindings.clear();
  }
  if (parentSignal?.aborted) dispose(); else parentSignal?.addEventListener('abort', dispose, {once: true});
  if (!disposed) frame.src = source.href;
  return Object.freeze({element, dispose, ready, inspect: async () => { if (phase === 'ready' && !disposed) await refresh(); return inspect(); }, execute, requestClose});
}
