/** Host-boundary tests with a synthetic engine. These do not qualify document fidelity. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

class Element extends EventTarget {
  children = [];
  dataset = {};
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {this.children = children;}
  setAttribute() {}
  remove() {}
  showModal() {}
  close() {}
  focus() {}
  querySelector(selector) {return this.children.find(child => selector.split(',').includes(child.tagName)) || this.children.map(child => child.querySelector?.(selector)).find(Boolean);}
  get lastElementChild() { return this.children.at(-1); }
}

async function fixture({authorize: policy, dirty = false, write, read, list, hostResult, snapshot, inspectDocument, selection, canvas, profileId = '', allowFailure = false, activateFile, openFile, newDocument, recovery = null, resource = null} = {}) {
  const origin = 'https://example.test', authority = Object.freeze({}), window = new EventTarget();
  const calls = [], writes = [], decisions = [], replies = [], body = new Element();
  let frame, saveId = 0, stateDirty = dirty, pendingSaves = 0, stateRevision = dirty ? 1 : 0;
  const serialized = new Map();
  const state = () => ({focused:true,caret:{x:10,y:10,h:12},...canvas,document: 1, dirty: stateDirty, pendingSaves: 0,
    documents: [{id: 1, dirty: stateDirty}], documentStates: [{id: 1, revision: stateDirty ? 1 : 0}], unsavedDocuments: stateDirty ? [1] : [],
    hostDocumentVersion: 1, hostOwnsDocuments: true,
    hostDocumentState: {active:'1', documents:[{id:'1',revision:String(stateRevision),dirty:stateDirty,pendingSaves}]}});
  const emit = data => {
    const event = new Event('message');
    Object.defineProperties(event, {origin: {value: origin}, source: {value: frame.contentWindow}, data: {value: data}});
    window.dispatchEvent(event);
  };
  const engine = {
    uiInspect: async () => state(), execute: async () => {},
    async request(method, args) {
      calls.push({method, args});
      if(method==='engine.execute'&&args.command==='document.selection')return selection();
      if(method==='document.inspect'&&inspectDocument)return inspectDocument(args);
      if(method==='engine.execute'&&args.command==='text.insert'){stateDirty=true;stateRevision++;}
      if(method==='engine.execute'&&args.command==='document.recoverySnapshot')return snapshot?snapshot(String(stateRevision)):{version:1,revision:String(stateRevision),data:'opaque native model '+stateRevision};
      if(method==='engine.execute'&&args.command==='file.open')return {id:1};
      if(method==='engine.execute'&&args.command==='design.defaultSnapshot')return {version:1,styles:{styles:[]},majorFont:'Inter',minorFont:'Source Sans 3',themeColors:[[1,2,3]]};
      if(method==='engine.execute'&&args.command==='design.validateDefaults')return args.params;
      if(method==='engine.execute'&&args.command==='ui.hostDefaultsResult'&&hostResult)return hostResult(args.params);
      if (method === 'engine.execute' && args.command === 'file.save') {
        const id = ++saveId; pendingSaves++;stateRevision++;serialized.set('wordcraft-save-'+id,stateRevision);
        queueMicrotask(() => emit({type: 'wordcraft:save', id: 'wordcraft-save-' + id,
          documentId: '1', revision: String(serialized.get('wordcraft-save-'+id)), name: 'Test.docx', bytes: new ArrayBuffer(1),
          operation: 'file.save', saveAs: false, documentSave: true, path:args.params.path || 'Documents/Test.docx'}));
        return {pendingSave: id};
      }
      if (method === 'engine.execute' && args.command === 'file.saveAs') {
        const id=++saveId;pendingSaves++;stateRevision++;serialized.set('wordcraft-save-'+id,stateRevision);
        queueMicrotask(()=>emit({type:'wordcraft:save',id:'wordcraft-save-'+id,documentId:'1',revision:String(serialized.get('wordcraft-save-'+id)),name:args.params.path.split('/').at(-1),bytes:new ArrayBuffer(1),operation:'file.saveAs',saveAs:true,documentSave:true,path:args.params.path}));
        return {pendingSave:id};
      }
      return {method, ...args};
    }
  };
  const document = Object.assign(new EventTarget(), {body, createElement(tag) {
    const node = new Element();node.tagName=tag;
    if (tag === 'iframe') { frame = node; node.contentWindow = {wordcraft: engine, focus() {},
      postMessage(data) { replies.push(data);if (['wordcraft:saved','wordcraft:save-result'].includes(data.type)) {stateDirty = stateRevision!==(serialized.get(data.id)??stateRevision);pendingSaves=0;}if(data.type==='wordcraft:save-failed')pendingSaves=0; }}; }
    return node;
  }});
  const context = vm.createContext({document, window, location: {href: origin + '/', origin},
    URL, AbortController, DOMException, setTimeout, clearTimeout, structuredClone, Blob,
    ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, btoa, queueMicrotask, crypto:webcrypto,
    MutationObserver:class {observe() {} disconnect() {}}});
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context});
  await module.link(async specifier => {
    if(specifier==='./style.css')return new vm.SyntheticModule([], () => {}, {context});
    assert(['./dialogs.mjs','./defaults.mjs'].includes(specifier));
    return new vm.SourceTextModule(await readFile(new URL('../'+specifier.slice(2),import.meta.url),'utf8'),{context});
  });
  await module.evaluate();
  const view = module.namespace.mount({instanceId: 'view-1', sessionId: 'session-1', url: '/editor', authority,
    resource,recovery,activateFile,openFile,newDocument,profileId,
    files: {check() {},async list(path){return list?list(path):{entries:[]};},async mkdir(){},async read(path){return read?read(path):{sha256:resource?.sha256||'b'.repeat(64),data:new Uint8Array([1])};},async version(){return {sha256:'b'.repeat(64)};},async write(path, bytes, previous) { writes.push({path, bytes, previous}); return write ? write(path,bytes,previous) : {sha256: 'a'.repeat(64)}; }},
    authorize: async (candidate, request) => { decisions.push({candidate, request: structuredClone(request)}); return policy ? policy(candidate, request, authority) : candidate === authority; }});
  emit({type: 'wordcraft:ready'}); if(allowFailure)await view.ready.catch(()=>{});else await view.ready; const startupCalls=structuredClone(calls);calls.length = 0; decisions.length = 0;
  return {view, authority, calls, startupCalls, decisions, writes, replies, body, emit,
    request: {instanceId: 'view-1', sessionId: 'session-1', documentId: '1', resourceId: resource?.path||'draft:1', command: 'text.insert', args: {text: 'authorized text'}}};
}

test('an omitted caller never inherits the human capability', async t => {
  const f = await fixture(); t.after(() => f.view.dispose());
  await assert.rejects(f.view.execute(f.request), /authoriz|denied|caller/i);
  assert.equal(f.calls.length, 0);
});

test('wrong credentials and cross-instance targets do not reach the engine', async t => {
  const f = await fixture(); t.after(() => f.view.dispose());
  await assert.rejects(f.view.execute(f.request, {}), /denied/i);
  await assert.rejects(f.view.execute({...f.request, instanceId: 'other-view'}, f.authority), /target/i);
  await assert.rejects(f.view.execute({...f.request, sessionId: 'other-session'}, f.authority), /target/i);
  await assert.rejects(f.view.execute({...f.request, resourceId: 'Documents/other.docx'}, f.authority), /denied/i);
  assert.equal(f.calls.length, 0);
});

test('authorization and execution use one captured command and argument snapshot', async t => {
  let approve, entered;
  const enteredPolicy = new Promise(resolve => { entered = resolve; });
  const f = await fixture({authorize: async () => { entered(); return new Promise(resolve => { approve = resolve; }); }});
  t.after(() => f.view.dispose());
  const pending = f.view.execute(f.request, f.authority);
  await enteredPolicy;
  f.request.command = 'file.delete'; f.request.documentId = '999'; f.request.args.text = 'changed after authorization';
  approve(true); const result = await pending;
  assert.equal(result.command, 'text.insert'); assert.equal(result.doc, 1); assert.equal(result.params.text, 'authorized text');
  assert.equal(f.decisions[0].request.operation, 'text.insert');
});

test('request capture precedes even the readiness await', async t => {
  const f = await fixture(); t.after(() => f.view.dispose());
  const pending = f.view.execute(f.request, f.authority);
  f.request.args.text = 'changed immediately';
  const result = await pending; assert.equal(result.params.text, 'authorized text');
});

test('policy can grant inspection while denying mutation to the same caller', async t => {
  const delegated = Object.freeze({});
  const f = await fixture({authorize: (candidate, request) => candidate === delegated && request.operation === 'document.inspect'});
  t.after(() => f.view.dispose());
  const result = await f.view.execute({...f.request, command: 'document.inspect'}, delegated);
  assert.equal(result.method, 'document.inspect');
  await assert.rejects(f.view.execute(f.request, delegated), /denied/i);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0);
});

test('a resource rebound by human Save As invalidates a pending command target', async t => {
  let approve, entered;
  const enteredPolicy = new Promise(resolve => { entered = resolve; });
  const f = await fixture({authorize: async (candidate, request, authority) => {
    if (request.operation === 'file.saveAs') return candidate === authority;
    entered(); return new Promise(resolve => { approve = resolve; });
  }});
  t.after(() => f.view.dispose());
  const pending = f.view.execute(f.request, f.authority); await enteredPolicy;
  f.emit({type: 'wordcraft:save', id: 'wordcraft-save-99', documentId: '1', revision: '1', name: 'Renamed.docx',
    bytes: new ArrayBuffer(1), operation: 'file.saveAs', saveAs: true, documentSave: true, path:'Documents/Renamed.docx'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1); approve(true);
  await assert.rejects(pending, /resource changed/i); assert.equal(f.calls.length, 0);
});

test('disposal while authorization waits prevents dispatch', async () => {
  let approve, entered;
  const enteredPolicy = new Promise(resolve => { entered = resolve; });
  const f = await fixture({authorize: async () => { entered(); return new Promise(resolve => { approve = resolve; }); }});
  const pending = f.view.execute(f.request, f.authority); await enteredPolicy;
  f.view.dispose(); approve(true); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.calls.length, 0);
});

test('close-dialog Save supplies human authority and waits for storage confirmation', async t => {
  const f = await fixture({dirty: true}); t.after(() => f.view.dispose());
  const closing = f.view.requestClose();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = f.view.element.querySelector('dialog'), save = dialog.children.at(-1).children.find(node => node.textContent === 'Save');
  assert(save); save.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  const pathDialog=f.view.element.children.filter(node=>node.tagName==='dialog').at(-1);
  pathDialog.querySelector('input').value='Documents/Test.docx';
  pathDialog.children.at(-1).children.find(node=>node.textContent==='Save').dispatchEvent(new Event('click'));
  assert.equal(await closing, true); assert.equal(f.writes.length, 1);
  assert(f.decisions.every(row => row.candidate === f.authority));
  assert.equal(f.writes[0].path, 'Documents/Test.docx');
});

test('confirmed Save As publishes its full account identity and ordinary Save reuses its revision', async t => {
  const f=await fixture({dirty:true});t.after(()=>f.view.dispose());const seen=[];
  f.view.fileBinding.subscribe(binding=>seen.push(binding));
  const saved=await f.view.execute({...f.request,command:'file.saveAs',args:{path:'Documents/Subfolder/Copy.docx'}},f.authority);
  assert.equal(saved.path,'Documents/Subfolder/Copy.docx');
  assert.equal(f.view.fileBinding.snapshot().path,saved.path);
  assert.equal(f.view.fileBinding.snapshot().revision,'a'.repeat(64));
  assert.equal(f.replies.at(-1).type,'wordcraft:save-result');
  assert.equal(f.replies.at(-1).path,saved.path);
  assert.equal(seen.at(-1).path,saved.path);
  await f.view.execute({...f.request,resourceId:saved.path,command:'file.save',args:{path:saved.path}},f.authority);
  assert.equal(f.writes[1].path,saved.path);assert.equal(f.writes[1].previous,'a'.repeat(64));
});

test('a failed Save As retains the confirmed source binding and sends failure to the engine', async t=>{
  const resource={path:'Documents/Original.docx',sha256:'b'.repeat(64)};
  const f=await fixture({resource,write:()=>{throw Error('synthetic collision');}});t.after(()=>f.view.dispose());
  await assert.rejects(f.view.execute({...f.request,command:'file.saveAs',args:{path:'Documents/Existing.docx'}},f.authority),/collision/);
  assert.equal(f.view.fileBinding.snapshot().path,resource.path);
  assert.equal(f.view.fileBinding.snapshot().revision,resource.sha256);
  assert.equal(f.replies.at(-1).type,'wordcraft:save-failed');
});

test('programmatic Open activates an existing account file without replacing the current native buffer', async t=>{
  const activated=[];
  const f=await fixture({dirty:true,activateFile:file=>{activated.push(file.path);return true;}});t.after(()=>f.view.dispose());
  const result=await f.view.execute({...f.request,command:'file.open',args:{path:'Documents/Already.docx'}},f.authority);
  assert.equal(result.status,'activated');assert.deepEqual(activated,['Documents/Already.docx']);
  assert.equal(f.calls.length,0);assert.equal(f.view.lifecycle.snapshot().dirty,true);
});

test('programmatic Open uses account versioning and the same host route for an unopened document', async t=>{
  const opened=[];
  const f=await fixture({openFile:file=>{opened.push(file);return {status:'opened'};}});t.after(()=>f.view.dispose());
  await f.view.execute({...f.request,command:'file.open',args:{path:'Documents/Other.docx'}},f.authority);
  assert.equal(opened[0].path,'Documents/Other.docx');assert.equal(opened[0].sha256,'b'.repeat(64));
  assert.equal(f.calls.length,0);
  await assert.rejects(f.view.execute({...f.request,command:'view.newWindow'},f.authority),/Desktop/);
  await assert.rejects(f.view.execute({...f.request,command:'file.open',args:{path:'../outside.docx'}},f.authority),/path/);
});

test('lifecycle pause uses a native revision lease and refuses public mutation until released',async t=>{
  const f=await fixture();t.after(()=>f.view.dispose());const before=f.view.lifecycle.snapshot();
  const lease=await f.view.lifecycle.quiesce();const pause=f.calls.at(-1);
  assert.equal(pause.args.command,'ui.hostPause');assert.equal(pause.args.params.document,'1');
  assert.equal(pause.args.params.revision,'0');assert.equal(pause.args.params.paused,true);
  assert.equal(f.view.lifecycle.snapshot().revision,before.revision);
  await assert.rejects(f.view.execute(f.request,f.authority),/paused/);
  lease.release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.at(-1).args.params.paused,false);
  await f.view.execute(f.request,f.authority);
});

test('a delayed save rebases recovery while retaining newer native edits',async t=>{
  let finish,entered;const started=new Promise(resolve=>{entered=resolve;});const drafts=[];
  const recovery={async load(){return null;},async write(value){drafts.push(structuredClone(value));},async clear(){drafts.length=0;},close(){}};
  const f=await fixture({dirty:true,recovery,write:()=>{entered();return new Promise(resolve=>{finish=resolve;});}});t.after(()=>f.view.dispose());
  const saving=f.view.execute({...f.request,command:'file.saveAs',args:{path:'Documents/Confirmed.docx'}},f.authority);await started;
  assert.equal(f.view.lifecycle.snapshot().pending,true);
  await f.view.execute(f.request,f.authority);finish({sha256:'a'.repeat(64)});await saving;await f.view.checkpoint();
  assert.equal(f.view.lifecycle.snapshot().dirty,true);
  assert.equal(drafts.at(-1).path,'Documents/Confirmed.docx');assert.equal(drafts.at(-1).revision,'a'.repeat(64));
  assert.match(drafts.at(-1).snapshot.data,/opaque native model/);
});

test('Retry keeps the intended account identity and restores public commands after an initial read failure',async t=>{
  let missing=true;
  const resource={path:'Documents/Temporary.docx',sha256:'b'.repeat(64)};
  const f=await fixture({resource,allowFailure:true,read:()=>{if(missing)throw Error('synthetic missing file');return {sha256:resource.sha256,data:new Uint8Array([1])};}});t.after(()=>f.view.dispose());
  await assert.rejects(f.view.ready,/missing file/);
  assert.equal((await f.view.inspect()).phase,'unavailable');assert.equal(f.view.fileBinding.snapshot().loaded,false);
  assert.equal((await f.view.inspect()).requestedPath,resource.path);assert.match((await f.view.inspect()).loadError,/missing file/);
  missing=false;await f.view.retry();assert.equal(f.view.fileBinding.snapshot().path,resource.path);
  await f.view.execute(f.request,f.authority);
  assert.equal(f.calls.at(-1).args.command,'text.insert');
});

test('programmatic Save with an explicit destination never opens a human path dialog',async t=>{
  const f=await fixture({dirty:true});t.after(()=>f.view.dispose());
  await f.view.execute({...f.request,command:'file.save',args:{path:'Documents/Explicit.docx'}},f.authority);
  assert.equal(f.writes[0].path,'Documents/Explicit.docx');
  assert.equal(f.view.element.children.some(n=>n.tagName==='dialog'),false);
});

test('a native revision arriving after discard confirmation prevents teardown and keeps recovery',async t=>{
  let clears=0;
  const recovery={async load(){return null;},async write(){},async clear(){clears++;},close(){}};
  const f=await fixture({dirty:true,recovery});t.after(()=>f.view.dispose());
  const closing=f.view.requestClose();await new Promise(resolve=>setImmediate(resolve));
  const dialog=f.view.element.querySelector('dialog');
  dialog.children.at(-1).children.find(n=>n.textContent==='Discard changes').dispatchEvent(new Event('click'));
  assert.equal(await closing,true);
  await f.view.execute(f.request,f.authority);
  await assert.rejects(f.view.lifecycle.commitClose(),/changed after close confirmation/);
  assert.equal(clears,0);
});

test('a Save As acknowledgement during snapshot transport cannot attach obsolete content to its new binding',async t=>{
  let release,entered,reads=0;const capturing=new Promise(resolve=>{entered=resolve;}),drafts=[];
  const recovery={async load(){return null;},async write(value){drafts.push(structuredClone(value));},async clear(){},close(){}};
  const resource={path:'Documents/Original.docx',sha256:'b'.repeat(64)};
  const f=await fixture({resource,dirty:true,recovery,snapshot:revision=>{if(++reads===1){entered();return new Promise(resolve=>{release=()=>resolve({version:1,revision,data:'obsolete snapshot before acknowledgement'});});}return {version:1,revision,data:'fresh snapshot after acknowledgement'};}});t.after(()=>f.view.dispose());
  const pending=f.view.checkpoint();await capturing;
  f.emit({type:'wordcraft:save',id:'wordcraft-save-99',documentId:'1',revision:'1',name:'New.docx',path:'Documents/New.docx',bytes:new ArrayBuffer(1),operation:'file.saveAs',saveAs:true,documentSave:true});
  await new Promise(resolve=>setImmediate(resolve));
  await f.view.execute({...f.request,resourceId:'Documents/New.docx'},f.authority);
  release();await pending;
  assert(drafts.length>0);assert(drafts.every(d=>d.path==='Documents/New.docx'&&d.revision==='a'.repeat(64)&&!d.snapshot.data.includes('obsolete')));
});

test('checkpoint requests coalesce while storage is slow and still capture the final newer edit',async t=>{
  let release,entered;const writing=new Promise(resolve=>{entered=resolve;}),drafts=[];
  const recovery={async load(){return null;},async write(value){drafts.push(structuredClone(value));if(drafts.length===1){entered();await new Promise(resolve=>{release=resolve;});}},async clear(){},close(){}};
  const f=await fixture({dirty:true,recovery});t.after(()=>f.view.dispose());
  const first=f.view.checkpoint();await writing;
  await f.view.execute(f.request,f.authority);const second=f.view.checkpoint(),third=f.view.checkpoint();
  assert.equal(first,second);assert.equal(second,third);release();await first;
  assert.equal(drafts.length,2);assert.notEqual(drafts[0].snapshot.revision,drafts[1].snapshot.revision);
});

test('the actual registered-account subject is passed as an opaque native storage profile',async t=>{
  const profileId='user:00000000-0000-0000-0000-000000000001';
  const f=await fixture({profileId});t.after(()=>f.view.dispose());
  const src=new URL(f.view.element.querySelector('iframe').src);
  assert.equal(src.searchParams.get('hostProfile'),profileId);assert.equal(src.searchParams.get('documentHost'),'1');
});

test('a failing metadata observer cannot turn a confirmed account write into a failed save',async t=>{
  const f=await fixture({dirty:true});t.after(()=>f.view.dispose());
  f.view.fileBinding.subscribe(()=>{throw Error('synthetic metadata observer failure');});
  f.view.lifecycle.subscribe(()=>{throw Error('synthetic lifecycle observer failure');});
  const saved=await f.view.execute({...f.request,command:'file.saveAs',args:{path:'Documents/Observed.docx'}},f.authority);
  assert.equal(saved.committed,true);assert.equal(f.view.fileBinding.snapshot().path,'Documents/Observed.docx');
  assert.equal(f.replies.at(-1).type,'wordcraft:save-result');assert.equal(f.replies.some(r=>r.type==='wordcraft:save-failed'),false);
});

test('document content cannot be returned after disposal invalidates an in-flight inspection',async()=>{
  let release,entered;const reading=new Promise(resolve=>{entered=resolve;});
  const f=await fixture({inspectDocument:()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  const request=f.view.execute({...f.request,command:'document.inspect'},f.authority);await reading;
  f.view.dispose();release({text:'synthetic content from a disposed document'});
  await assert.rejects(request,error=>error.name==='AbortError');
});

test('native Open preserves newer typing instead of rejecting the gesture because its revision advanced',async t=>{
  const activated=[];
  const f=await fixture({dirty:true,activateFile:file=>{activated.push(file.path);return true;}});t.after(()=>f.view.dispose());
  f.emit({type:'wordcraft:document-request',document:'1',revision:'0',command:'file.open',params:{path:'Documents/Existing.docx'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(activated,['Documents/Existing.docx']);assert.equal(f.view.lifecycle.snapshot().dirty,true);assert.equal(f.calls.length,0);
});

test('account defaults load before blank creation but never on existing-file Open',async t=>{
  const defaults={version:1,styles:{styles:[]},majorFont:'Inter',minorFont:'Source Sans 3',themeColors:[[1,2,3]]};
  const listing=async path=>({entries:path==='Digital Projects'?[{name:'WordCraft',directory:true}]:[{name:'defaults-v1.json',directory:false,bytes:200}]});
  const fresh=await fixture({list:listing,read:async()=>({sha256:'a'.repeat(64),data:new TextEncoder().encode(JSON.stringify(defaults))})});
  t.after(()=>fresh.view.dispose());
  const commands=fresh.startupCalls.filter(c=>c.method==='engine.execute');
  assert.deepEqual(commands.map(c=>c.args.command),['design.loadDefaults','file.new']);
  assert.equal(commands[0].args.params.minorFont,'Source Sans 3');
  const opened=await fixture({resource:{path:'Documents/Existing.docx',sha256:'b'.repeat(64)},list:()=>{throw Error('Existing documents must not load defaults');}});
  t.after(()=>opened.view.dispose());
  assert.equal(opened.startupCalls.some(c=>c.args?.command==='design.loadDefaults'),false);
});

test('Set as Default requires account authorization and acknowledges only confirmed storage',async t=>{
  const denied=await fixture({authorize:(candidate,target,authority)=>candidate===authority&&target.operation!=='design.setDefault'});t.after(()=>denied.view.dispose());
  await assert.rejects(denied.view.execute({...denied.request,command:'design.setDefault'},denied.authority),/denied/);
  assert.equal(denied.writes.length,0);
  const f=await fixture({dirty:true});t.after(()=>f.view.dispose());
  const saved=await f.view.execute({...f.request,command:'design.setDefault',args:{}},f.authority);
  assert.equal(saved.committed,true);assert.equal(saved.path,'Digital Projects/WordCraft/defaults-v1.json');
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].previous,null);
  assert.equal(f.view.lifecycle.snapshot().dirty,true,'saving defaults must not mark the document saved');
  assert.equal(f.calls.at(-1).args.command,'ui.hostDefaultsResult');assert.equal(f.calls.at(-1).args.params.saved,true);
  assert(f.decisions.some(d=>d.request.resourceId==='Digital Projects/WordCraft/defaults-v1.json'));
});

test('native ribbon defaults use the same storage path and failed writes never announce success',async t=>{
  const defaults={version:1,styles:{styles:[]},majorFont:'Inter',minorFont:'Source Sans 3',themeColors:[[1,2,3]]};
  const f=await fixture({write:async()=>{throw Object.assign(Error('changed by another window'),{status:409});}});t.after(()=>f.view.dispose());
  f.emit({type:'wordcraft:document-request',document:'1',revision:'0',command:'design.setDefault',params:{defaults}});
  for(let attempt=0;attempt<20&&!f.calls.some(c=>c.args?.command==='ui.hostDefaultsResult');attempt++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.writes.length,1);assert.equal(f.calls.at(-1).args.command,'ui.hostDefaultsResult');
  assert.equal(f.calls.at(-1).args.params.saved,false);
  assert.equal(f.calls.some(c=>c.args?.command==='design.loadDefaults'),false,'failed storage must not install an unconfirmed default');
});

test('a failed native status update cannot relabel confirmed defaults as a failed account save',async t=>{
  const f=await fixture({hostResult:async()=>{throw Error('synthetic status transport failure');}});t.after(()=>f.view.dispose());
  const saved=await f.view.execute({...f.request,command:'design.setDefault',args:{}},f.authority);
  assert.equal(saved.committed,true);assert.equal(f.writes.length,1);
  assert.equal(f.calls.some(c=>c.args?.command==='ui.hostDefaultsResult'&&c.args.params.saved===false),false);
});

test('selected-page PDF uses authorized host storage and never rebinds the document', async t => {
  const resource={path:'Documents/Source.docx',sha256:'b'.repeat(64)};
  const f=await fixture({resource,dirty:true}); t.after(()=>f.view.dispose());
  const before=f.view.fileBinding.snapshot();
  f.emit({type:'wordcraft:save',id:'wordcraft-save-98',documentId:'1',revision:'1',name:'Pages.pdf',
    bytes:new ArrayBuffer(8),operation:'file.printPdf',saveAs:false,documentSave:false,path:'Documents/Pages.pdf'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].path,'Documents/Pages.pdf');
  assert.equal(f.writes[0].bytes.size,8);
  assert(f.decisions.some(d=>d.request.operation==='file.printPdf'&&d.request.resourceId===resource.path));
  assert.equal(f.replies.at(-1).type,'wordcraft:saved');
  assert.deepEqual(f.view.fileBinding.snapshot(),before);
});

test('public editor focus restores native caret focus without a save or resource change', async t => {
  const f=await fixture();t.after(()=>f.view.dispose());
  const before=f.view.fileBinding.snapshot();
  assert.equal(f.view.focus(),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert(f.calls.some(c=>c.method==='ui.focus'&&c.args.doc===1));
  assert.equal(f.writes.length,0);
  assert.deepEqual(f.view.fileBinding.snapshot(),before);
});


test('dictation replaces only the captured document selection', async t => {
  let anchor = 1;
  const f = await fixture({selection:()=>({anchor:{off:anchor},focus:{off:5}})});
  t.after(()=>f.view.dispose());
  const frame=f.view.element.querySelector('iframe');
  const stale=frame.codiVoiceCapture();
  await new Promise(resolve=>setTimeout(resolve,0));
  anchor=2;
  await assert.rejects(stale.insert('wrong selection'),/selection changed/i);
  assert.equal(f.calls.filter(c=>c.args.command==='text.insert').length,0);
  await frame.codiVoiceCapture().insert('spoken words');
  const edits=f.calls.filter(c=>c.args.command==='text.insert');
  assert.equal(edits.length,1);
  assert.equal(edits[0].args.params.text,'spoken words');
  assert.equal(edits[0].args.doc,1);
});


test('a selected page accepts dictation after the launcher takes focus, and a ribbon click clears it', async t => {
  const canvas={focused:false,window:[400,300],canvasRect:[0,75,400,225],pages:[[20,80,360,300]]};
  const f=await fixture({canvas,selection:()=>({anchor:{off:0},focus:{off:1}})});
  t.after(()=>f.view.dispose());
  const frame=f.view.element.querySelector('iframe');
  let pointerDown;
  frame.contentDocument={addEventListener(type,listener){if(type==='pointerdown')pointerDown=listener;}};
  frame.dispatchEvent(new Event('load'));
  const target={localName:'canvas',getBoundingClientRect:()=>({left:0,top:0,width:400,height:300})};
  pointerDown({target,clientX:40,clientY:120});
  await frame.codiVoiceCapture().insert('on the page');
  pointerDown({target,clientX:40,clientY:20});
  await assert.rejects(frame.codiVoiceCapture().insert('on the ribbon'),/selection changed/);
  assert.equal(f.calls.filter(c=>c.args.command==='text.insert').length,1);
});
