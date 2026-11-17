/** Same-origin view of the real WordCraft engine and shared account storage. */
import './style.css';
import {canonicalPath, createDialogs} from './dialogs.mjs';
const MAX_FILE = 128 * 1024 * 1024;
const decimal = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.startsWith('.') && !/[\x00-\x1f/\\]/.test(name);
const base64 = bytes => { const parts = []; for (let i = 0; i < bytes.length; i += 24576) { let text = ''; for (const value of bytes.subarray(i, i + 24576)) text += String.fromCharCode(value); parts.push(btoa(text)); } return parts.join(''); };

export function mount({instanceId, sessionId, resource = null, imported = null, template = 'blank', recoveryAsCopy = false, profileId = '', files, authority, authorize, recovery = null,
  openFile, activateFile, newDocument, importDocument, closeView, displayName = '', url, signal: parentSignal}) {
  if (!instanceId || !sessionId || !files || typeof authorize !== 'function') throw TypeError('WordCraft requires explicit instance/session identity, Storage and authorization.');
  const source = new URL(url, location.href); if (source.origin !== location.origin) throw Error('This WordCraft integration requires same-origin trusted code.');
  source.searchParams.set('host', 'parent'); source.searchParams.set('author', displayName); source.searchParams.set('documentHost', '1');
  if (/^[A-Za-z0-9_:-]{1,256}$/.test(profileId)) source.searchParams.set('hostProfile', profileId);
  const element = document.createElement('div'), frame = document.createElement('iframe'), status = document.createElement('div'), recoveryStatus = document.createElement('div'), retryButton = document.createElement('button');
  element.className = 'webos-wordcraft'; frame.title = 'WordCraft document'; frame.allow = 'clipboard-read; clipboard-write';
  status.className = 'webos-wordcraft-status'; status.setAttribute('role', 'status'); recoveryStatus.className = 'webos-wordcraft-recovery'; recoveryStatus.setAttribute('role', 'status');
  retryButton.type = 'button'; retryButton.textContent = 'Retry'; retryButton.hidden = true; element.append(frame, status, recoveryStatus, retryButton);
  const abort = new AbortController(), bindings = new Map(), completions = new Map(), pendingDocuments = new Set(), listeners = new Set(), bindingListeners = new Set();
  let disposed = false, phase = 'loading', loadError = '', currentDocument = null, nativeState = null, nativeFingerprint = '', lifecycleRevision = 0, loaded = false,
    readyResolve, readyReject, initializing = false, nativeReady = false, paused = false, lease = null, closeIntent = null, timer,
    recoveryState = recovery ? 'ready' : 'unavailable', needsCopy = false, deferredRecovery = false, checkpointTail = Promise.resolve(), checkpointSequence = 0, checkpointRunning = null, checkpointRequested = false, lastCheckpoint = Date.now(), commandPending = 0;
  const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject}); ready.catch(() => {});
  const check = () => { if (disposed || abort.signal.aborted) throw new DOMException('Editor view closed.', 'AbortError'); files.check(); };
  const api = () => { check(); const value = frame.contentWindow?.wordcraft; if (!value || typeof value.request !== 'function') throw Error('WordCraft command interface unavailable.'); return value; };
  const dialogs = createDialogs({element, signal: abort.signal, check, onChange: () => changed()});
  const activeState = () => nativeState?.documents.find(document => document.id === currentDocument);
  const dirty = () => loaded && !!nativeState?.documents.some(document => document.dirty);
  const pending = () => pendingDocuments.size > 0 || !!nativeState?.documents.some(document => document.pendingSaves > 0) || commandPending > 0 || initializing || dialogs.active;
  const bindingSnapshot = () => {const binding = bindings.get(currentDocument); return Object.freeze({documentId: currentDocument, path: binding?.path ?? null, revision: binding?.sha256 ?? null, loaded});};
  let lastBinding = '';
  function publish(observers,value) {
    for(const listener of [...observers]){
      try{listener(value);}catch(error){console.error('WordCraft observer failed.',error);}
    }
  }
  function changed({invalidateClose = true} = {}) {
    if (disposed) return; lifecycleRevision++; if (invalidateClose) closeIntent = null;
    const binding = bindingSnapshot(), fingerprint = JSON.stringify(binding);
    if (fingerprint !== lastBinding) {lastBinding = fingerprint; publish(bindingListeners,binding);}
    publish(listeners);
  }
  function applyState(value) {
    if (!value || !decimal(value.active) || !Array.isArray(value.documents) || value.documents.length > 64 || !value.documents.some(d => d.id === value.active) ||
      value.documents.some(d => !decimal(d.id) || !decimal(d.revision) || typeof d.dirty !== 'boolean' || !Number.isSafeInteger(d.pendingSaves) || d.pendingSaves < 0)) throw Error('Invalid native WordCraft document state.');
    const next = {active:value.active,documents:value.documents.map(d=>({id:d.id,revision:d.revision,dirty:d.dirty,pendingSaves:d.pendingSaves}))};
    const fingerprint = JSON.stringify(next); currentDocument = next.active; nativeState = next;
    if (fingerprint !== nativeFingerprint) {nativeFingerprint = fingerprint; changed(); if (loaded && !paused) scheduleCheckpoint();}
  }
  async function refresh() {
    const value = await api().uiInspect(); check();
    if (value.hostDocumentVersion !== 1 || value.hostOwnsDocuments !== true) throw Error('This WordCraft engine lacks the document-host contract.');
    applyState(value.hostDocumentState); return value;
  }
  const target = () => ({instanceId,sessionId,documentId:currentDocument,resourceId:bindings.get(currentDocument)?.path || (currentDocument ? 'draft:'+currentDocument : null)});
  const inspect = () => ({...target(),...bindingSnapshot(),phase,loadError,requestedPath:loaded?null:resource?.path??null,disposed,dirty:dirty(),pendingSaves:pendingDocuments.size,
    documents:structuredClone(nativeState?.documents ?? []),files:[...bindings].map(([documentId,binding])=>({documentId,...binding})),recovery:recoveryState,needsCopy});
  function notify(error) {if (!disposed && error.name !== 'AbortError') status.textContent = error.message;}
  function reply(type, fields) {if (!disposed) frame.contentWindow.postMessage({type,...fields},location.origin);}
  function completion(id) {
    if (!completions.has(id)) {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});completions.set(id,{promise,resolve,reject});}
    return completions.get(id);
  }
  function recoveryNotice(state,message) {if (!disposed) {recoveryState=state;recoveryStatus.textContent=message;}}
  function scheduleCheckpoint() {
    clearTimeout(timer);
    // Continuous typing still produces a checkpoint. A trailing-edge debounce
    // alone can postpone recovery indefinitely while the writer keeps typing.
    const delay=Math.min(250,Math.max(0,5000-(Date.now()-lastCheckpoint)));
    timer=setTimeout(()=>void checkpoint().catch(()=>{}),delay);
  }
  function checkpoint() {
    clearTimeout(timer); if (!recovery || !loaded || disposed) return Promise.resolve();
    checkpointRequested=true;if(checkpointRunning)return checkpointRunning;
    const sequence=++checkpointSequence;
    const capture=async()=>{
      let written;
      do {
        checkpointRequested=false;check();await refresh();check();
        if(!dirty()) {
          if(!pending()){await recovery.clear();written=false;}
        } else {
          const documentId=currentDocument;
          const binding=bindings.get(documentId);
          const snapshot=await api().request('engine.execute',{command:'document.recoverySnapshot',params:{},doc:Number(documentId)});check();
          if(currentDocument!==documentId)throw Error('Recovery target changed.');
          // A Save As acknowledgement can arrive while the native response is
          // in flight. Recapture instead of attaching old content to its new base.
          if(bindings.get(documentId)!==binding){checkpointRequested=true;continue;}
          recoveryNotice('writing','Updating local recovery…');
          await recovery.write({path:binding?.path??null,revision:binding?.sha256??null,snapshot});check();written=true;
        }
        lastCheckpoint=Date.now();
      }while(checkpointRequested&&!disposed);
      return written;
    };
    const work=capture().then(written=>{
      if(sequence===checkpointSequence&&typeof written==='boolean')recoveryNotice(written?'stored':'ready',written?'Local recovery draft updated in this browser. Not saved to your account.':'');
    },error=>{
      if(sequence===checkpointSequence)recoveryNotice('failed','Local recovery unavailable: '+error.message+' Keep this window open and save your work.');throw error;
    });
    checkpointRunning=work;checkpointTail=work;
    void work.finally(()=>{if(checkpointRunning===work)checkpointRunning=null;}).catch(()=>{});
    return work;
  }
  async function nativeCommand(command,params={},doc=currentDocument) {
    check();if(paused)throw Error('WordCraft is paused while the desktop ends this session.');
    commandPending++;changed();
    try {
      const result=await api().request('engine.execute',{command,params,...(doc?{doc:Number(doc)}:{})});check();
      if(result?.pendingSave){const saved=await completion('wordcraft-save-'+result.pendingSave).promise;check();await settleSave();return saved;}
      await refresh();return result;
    } finally {commandPending--;if(!disposed){changed();if(loaded)scheduleCheckpoint();}}
  }
  async function settleSave() {
    // A host acknowledgement is applied by the next native frame. Do not clear
    // recovery using the pre-ack state or claim the native title already changed.
    for(let attempt=0;attempt<100;attempt++){
      await refresh();if(!nativeState.documents.some(d=>d.pendingSaves))return;
      await new Promise(resolve=>setTimeout(resolve,25));check();
    }
    throw Error('The server confirmed this save, but WordCraft has not applied its result yet. Keep this window open.');
  }
  async function save(message) {
    const id=message.id,documentId=message.documentId;
    if(typeof id!=='string'||!/^wordcraft-save-[0-9]+$/.test(id)){status.textContent='Refused a save without its completion identity.';return;}
    const done=completion(id);if(done.started)return;done.started=true;let admitted=false;
    try {
      check();
      if(!loaded||!decimal(documentId)||documentId!==currentDocument||!decimal(message.revision)||!validName(message.name)||!(message.bytes instanceof ArrayBuffer)||message.bytes.byteLength>MAX_FILE||typeof message.saveAs!=='boolean'||typeof message.documentSave!=='boolean'||!['file.save','file.saveAs','file.exportPdf','file.exportPng'].includes(message.operation))throw Error('Invalid identified WordCraft save.');
      const original=bindings.get(documentId),resourceId=original?.path||'draft:'+documentId;
      if(await authorize(authority,{instanceId,sessionId,documentId,operation:message.operation,resourceId})!==true)throw Error('Save is not authorized.');
      check();if((bindings.get(documentId)?.path||'draft:'+documentId)!==resourceId)throw Error('Document resource changed during save authorization.');
      if(paused||pendingDocuments.has(documentId))throw Error('Wait for the pending document operation before saving.');
      pendingDocuments.add(documentId);admitted=true;changed();
      let destination=typeof message.path==='string'?canonicalPath(message.path):null;
      const ordinary=message.operation==='file.save'&&original&&!message.saveAs;
      if(ordinary) {
        if(destination!==original.path&&destination!==original.path.split('/').at(-1))throw Error('Save target differs from the confirmed account file.');
        destination=original.path;
      } else if(!destination) throw Error('Save requires an explicit relative account path.');
      if(needsCopy&&destination===original?.path)throw Error('The saved base changed or could not be verified. Use Save As to keep this recovered copy.');
      status.textContent='Saving to your account…';
      const saved=await files.write(destination,new Blob([message.bytes]),destination===original?.path?original.sha256:null,{signal:abort.signal});check();
      if(!digest(saved?.sha256))throw Error('Server save confirmation is invalid.');
      if(message.documentSave){bindings.set(documentId,{path:destination,sha256:saved.sha256});needsCopy=false;changed();}
      status.textContent='Saved to your account: '+destination;
      reply(message.documentSave?'wordcraft:save-result':'wordcraft:saved',{id,...(message.documentSave?{path:destination}:{})});
      done.resolve({status:'saved',path:destination,sha256:saved.sha256,committed:true,documentSave:message.documentSave});
      void settleSave().then(()=>checkpoint()).catch(notify);
    }catch(error){if(!disposed){status.textContent=error.message+(error.outcome==='unknown'?' The server outcome is unknown; check the file before retrying.':'');reply('wordcraft:save-failed',{id,error:status.textContent});}done.reject(error);}
    finally {if(admitted)pendingDocuments.delete(documentId);if(!disposed)changed();}
  }
  async function saveDocument(asCopy=false) {
    const binding=bindings.get(currentDocument);
    const destination=asCopy||!binding||needsCopy?await dialogs.path(binding?.path||'Documents/Untitled.docx'):null;check();
    if((asCopy||!binding||needsCopy)&&destination===null)return false;
    await nativeCommand(destination?'file.saveAs':'file.save',destination?{path:destination}:{path:binding.path});
    await refresh();await checkpoint().catch(()=>{});return !dirty();
  }
  async function openAccount(path) {
    canonicalPath(path);check();
    if(activateFile?.({path}))return {status:'activated',path};
    if(typeof openFile!=='function')throw Error('The Desktop account-open service is unavailable.');
    const version=await files.version(path);check();if(!digest(version.sha256))throw Error('Invalid account-file revision.');
    return openFile({path,sha256:version.sha256});
  }
  async function hostAction(command,params={}) {
    check();if(paused||!loaded)throw Error('WordCraft document is unavailable.');
    if(command==='file.new'){if(typeof newDocument!=='function')throw Error('Desktop document launch is unavailable.');return newDocument(params);}
    if(command==='file.close'){if(typeof closeView!=='function')throw Error('Desktop close is unavailable.');return closeView();}
    if(command==='file.saveAs')return saveDocument(true);
    if(command==='file.open'||command==='ui.openFileDialog'){
      if(typeof params.data==='string') {
        if(params.data.length>Math.ceil(MAX_FILE/3)*4||!validName(params.path?.split('/').at(-1)))throw Error('Invalid imported document.');
        if(typeof importDocument!=='function')throw Error('Desktop document import is unavailable.');
        return importDocument({name:params.path.split('/').at(-1),data:params.data});
      }
      if(typeof params.path==='string')return openAccount(params.path);
      const path=bindings.get(currentDocument)?.path;
      const choice=await dialogs.open(files,path?.includes('/')?path.slice(0,path.lastIndexOf('/')):'');check();if(!choice)return {status:'cancelled'};
      if(choice.kind==='account')return openAccount(choice.path);
      if(typeof importDocument!=='function')throw Error('Desktop document import is unavailable.');
      const bytes=new Uint8Array(await choice.file.arrayBuffer());check();return importDocument({name:choice.file.name,data:base64(bytes)});
    }
    throw Error('Unknown native document request.');
  }
  function startupFailed(error) {
    if(disposed)return;phase='failed';loadError=error.message;status.textContent=error.message;clearTimeout(startup);readyReject(error);frame.inert=true;
  }
  async function initialize() {
    check();if(initializing)throw Error('WordCraft is still opening this document.');if(loaded)throw Error('The document is already open.');
    initializing=true;changed();retryButton.hidden=true;phase='loading';loadError='';frame.inert=true;
    try {
      await refresh();
      let draft=null;
      if(recovery){try{draft=await recovery.load();check();}catch(error){check();recoveryNotice('failed','Local recovery unavailable: '+error.message);}}
      if(draft){
        let changedBase=false;if(draft.path){try{changedBase=(await files.version(draft.path)).sha256!==draft.revision;}catch{changedBase=true;}check();}
        const choice=await dialogs.recover(draft.path,changedBase);check();
        if(!choice){deferredRecovery=true;phase='recovery';retryButton.textContent='Recover draft';retryButton.hidden=false;status.textContent='Local draft retained. Choose Recover draft to review it.';readyResolve();return;}
        deferredRecovery=false;
        if(choice==='recover'){
          const initial=activeState();
          const result=await api().request('engine.execute',{command:'document.restoreSnapshot',params:{version:draft.snapshot.version,data:draft.snapshot.data,expectedRevision:initial.revision,sourcePath:recoveryAsCopy?null:draft.path},doc:Number(currentDocument)});check();
          if(!Number.isSafeInteger(result.id)||result.saved!==false)throw Error('Invalid native recovery result.');
          currentDocument=String(result.id);if(draft.path&&!recoveryAsCopy)bindings.set(currentDocument,{path:draft.path,sha256:draft.revision});needsCopy=changedBase&&!recoveryAsCopy;
          status.textContent=needsCopy?'Recovered local draft. The saved file changed or is unavailable; use Save As.':'Recovered local draft. Changes are not saved to your account.';
        } else {await recovery.clear();check();draft=null;}
      }
      if(!draft){
        if(resource){
          canonicalPath(resource.path);if(!resource.restore&&!digest(resource.sha256))throw Error('An exact account file identity and revision are required.');
          const opened=await files.read(resource.path);check();if(!digest(opened.sha256))throw Error('Invalid server file revision.');
          if(!resource.restore&&opened.sha256!==resource.sha256)throw Error('This file changed before opening. Refresh Files and open it again.');
          const bytes=opened.data instanceof Blob?new Uint8Array(await opened.data.arrayBuffer()):opened.data;check();
          const result=await api().request('engine.execute',{command:'file.open',params:{path:resource.path,data:base64(bytes)}});check();
          if(!Number.isSafeInteger(result.id))throw Error('WordCraft did not identify the opened document.');
          currentDocument=String(result.id);bindings.set(currentDocument,{path:resource.path,sha256:opened.sha256});status.textContent='Opened account file: '+resource.path;
        }else if(imported){
          if(!validName(imported.name)||typeof imported.data!=='string'||imported.data.length>Math.ceil(MAX_FILE/3)*4)throw Error('Invalid document import.');
          await api().request('engine.execute',{command:'file.open',params:{path:imported.name,data:imported.data,unsaved:true}});check();
          status.textContent='Imported document; use Save As to save it to your account.';
        }else{await api().request('engine.execute',{command:'file.new',params:{template}});check();status.textContent='New document; not saved to your account.';}
      }
      await api().execute('ui.backstage',{value:false});check();await refresh();loaded=true;phase='ready';frame.inert=false;clearTimeout(startup);changed();readyResolve();
      if(draft||imported)scheduleCheckpoint();
      imported=null;
    }catch(error){if(!disposed){phase='unavailable';loadError=error.message;status.textContent='Could not open '+(resource?.path||'this document')+': '+error.message+' Retry when it is available.';retryButton.textContent='Retry';retryButton.hidden=false;readyReject(error);}throw error;}
    finally {initializing=false;if(!disposed)changed();}
  }
  async function execute(request,candidate) {
    if(candidate===undefined||candidate===null)throw Error('Explicit caller authorization required.');
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Exact editor instance, session and document target required.');
    const raw=JSON.stringify(request);if(typeof raw!=='string'||raw.length>65536)throw Error('Command request exceeds the bounded metadata contract.');const captured=JSON.parse(raw);
    if(!loaded)await ready;check();
    if(!loaded||captured.instanceId!==instanceId||captured.sessionId!==sessionId||captured.documentId!==currentDocument||!decimal(captured.documentId)||typeof captured.command!=='string')throw Error('Exact current editor instance, session and document target required.');
    const resourceId=bindings.get(currentDocument)?.path||'draft:'+currentDocument;
    if(captured.resourceId!==resourceId||await authorize(candidate,{instanceId,sessionId,documentId:captured.documentId,resourceId,operation:captured.command})!==true)throw Error('Document operation is unavailable or denied.');check();
    if((bindings.get(currentDocument)?.path||'draft:'+currentDocument)!==resourceId||captured.documentId!==currentDocument)throw Error('Document resource changed while authorization was pending.');
    const args=captured.args||{},command=captured.command;if(!Number.isSafeInteger(Number(currentDocument)))throw Error('Invalid document identity.');
    if(command==='document.inspect'){
      const result=await api().request('document.inspect',{...args,doc:Number(currentDocument)});check();return result;
    }
    if(paused)throw Error('WordCraft is paused while the desktop ends this session.');
    if(command==='file.open'){if(typeof args.path!=='string'||Object.hasOwn(args,'data'))throw Error('Programmatic Open requires an account file path.');return openAccount(args.path);}
    if(command==='file.new')return hostAction(command,args);
    if(command==='file.close'){if(dirty()||pending())throw Error('Save or close this document through its close workflow first.');return hostAction(command,args);}
    if(['view.newWindow','view.switchWindows','file.closeDocument','document.restoreSnapshot','ui.hostPause','ui.openFileDialog'].includes(command))throw Error('This operation is coordinated by the Desktop.');
    if(command==='file.saveAs'&&!args.path)throw Error('Programmatic Save As requires an account-relative path.');
    if(args.path&&(command==='file.saveAs'||command==='file.save'))canonicalPath(args.path);
    if(command==='file.save'&&!bindings.has(currentDocument)&&!args.path)throw Error('Save As requires an explicit account-relative path.');
    return nativeCommand(command,args);
  }
  async function requestClose() {
    check();closeIntent=null;if(!loaded)return !pending();await refresh();
    if(pending()){status.textContent='Wait for the current operation before closing.';return false;}
    if(!dirty())return true;await checkpoint().catch(()=>{});await refresh();
    const before=nativeFingerprint,choice=await dialogs.close();check();await refresh();
    if(choice==='discard'){if(nativeFingerprint!==before){status.textContent='Document changed during confirmation. Review the newer edits.';return false;}closeIntent=nativeFingerprint;return true;}
    if(choice==='save'){try{return await saveDocument();}catch(error){notify(error);}}
    return false;
  }
  const lifecycle=Object.freeze({
    snapshot:()=>Object.freeze({revision:lifecycleRevision,dirty:dirty(),pending:pending()}),
    subscribe(listener){if(typeof listener!=='function')throw TypeError('Lifecycle listener required.');listeners.add(listener);return()=>listeners.delete(listener);},
    async quiesce({signal}={}){
      check();if(signal?.aborted||paused||lease||pending())throw Error('Finish the pending WordCraft operation before ending the session.');
      if(!loaded)return Object.freeze({release(){}});
      await refresh();const document=activeState(),token=crypto.randomUUID();frame.inert=true;paused=true;
      try{await api().request('engine.execute',{command:'ui.hostPause',params:{paused:true,lease:token,document:document.id,revision:document.revision},doc:Number(document.id)});check();}
      catch(error){paused=false;frame.inert=false;throw error;}
      let active=true;
      const release=()=>{if(!active)return;active=false;signal?.removeEventListener('abort',release);if(lease===release)lease=null;if(disposed)return;
        void api().request('engine.execute',{command:'ui.hostPause',params:{paused:false,lease:token},doc:Number(document.id)}).then(()=>{if(!disposed){paused=false;frame.inert=false;}},notify);};
      lease=release;signal?.addEventListener('abort',release,{once:true});if(signal?.aborted){release();throw Error('WordCraft pause cancelled.');}return Object.freeze({release});
    },
    async commitClose(){
      if(disposed)return true;if(pending())throw Error('Wait for the current operation before closing.');
      clearTimeout(timer);await checkpointTail.catch(()=>{});
      let ownPause;
      try {
        // Ordinary window close must freeze the real engine too. Session end
        // already holds this lease before authentication is invalidated.
        if(loaded&&!paused)ownPause=await lifecycle.quiesce();
        if(loaded&&dirty()&&closeIntent!==nativeFingerprint)throw Error('WordCraft changed after close confirmation.');
        if(loaded)await recovery?.clear();recovery?.close();return true;
      }catch(error){ownPause?.release();throw error;}
    }
  });
  function message(event){
    if(disposed||event.origin!==location.origin||event.source!==frame.contentWindow||!event.data||typeof event.data!=='object')return;
    const value=event.data;
    if(value.type==='wordcraft:ready'&&!nativeReady){nativeReady=true;clearTimeout(startup);void initialize().catch(notify);}
    if(value.type==='wordcraft:save')void save(value);
    if(value.type==='wordcraft:document-state'){try{applyState(value);}catch(error){notify(error);}}
    if(value.type==='wordcraft:document-request'){
      void (async()=>{check();await refresh();
        // New/Open preserve this buffer; Save As and Close inspect it again at
        // confirmation. Ordinary typing after the gesture must not cancel Open.
        if(value.document!==currentDocument||!decimal(value.revision))throw Error('Native document request is stale.');
        await hostAction(value.command,structuredClone(value.params||{}));})().catch(notify);
    }
    if(value.type==='wordcraft:failed')startupFailed(Error(String(value.error||'WordCraft failed to start.')));
  }
  window.addEventListener('message',message,{signal:abort.signal});
  const startup=setTimeout(()=>{if(phase==='loading'&&!disposed)startupFailed(Error('WordCraft startup timed out.'));},120000);
  retryButton.addEventListener('click',()=>void initialize().catch(notify),{signal:abort.signal});
  const persist=()=>{if(!disposed&&loaded)void checkpoint().catch(()=>{});};
  const visibility=()=>{if(document.hidden)persist();};document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',persist);
  function dispose(){
    if(disposed)return;disposed=true;phase='disposed';parentSignal?.removeEventListener('abort',dispose);clearTimeout(startup);clearTimeout(timer);abort.abort();recovery?.close();
    document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',persist);listeners.clear();bindingListeners.clear();
    readyReject(new DOMException('Editor view closed.','AbortError'));for(const done of completions.values())done.reject(new DOMException('Editor view closed; verify any pending save before retrying.','AbortError'));
    frame.src='about:blank';frame.remove();element.remove();bindings.clear();
  }
  if(parentSignal?.aborted)dispose();else parentSignal?.addEventListener('abort',dispose,{once:true});if(!disposed)frame.src=source.href;
  return Object.freeze({element,dispose,ready,execute,requestClose,lifecycle,
    fileBinding:Object.freeze({snapshot:bindingSnapshot,subscribe(listener){if(typeof listener!=='function')throw TypeError('Binding listener required.');bindingListeners.add(listener);return()=>bindingListeners.delete(listener);}}),
    retry:()=>initialize(),checkpoint,
    focus(){check();if(!loaded||dialogs.active||paused)return false;frame.contentWindow.focus();frame.contentDocument?.querySelector('canvas')?.focus();return true;},
    inspect:async()=>{if(nativeReady&&!disposed)await refresh();return inspect();}
  });
}
