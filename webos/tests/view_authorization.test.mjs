/** Host-boundary tests with a synthetic engine. These do not qualify document fidelity. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Element extends EventTarget {
  children = [];
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  remove() {}
  showModal() {}
  close() {}
  focus() {}
  get lastElementChild() { return this.children.at(-1); }
}

async function fixture({authorize: policy, dirty = false} = {}) {
  const origin = 'https://example.test', authority = Object.freeze({}), window = new EventTarget();
  const calls = [], writes = [], decisions = [], body = new Element();
  let frame, saveId = 0, stateDirty = dirty;
  const state = () => ({document: 1, dirty: stateDirty, pendingSaves: 0,
    documents: [{id: 1, dirty: stateDirty}], documentStates: [{id: 1, revision: stateDirty ? 1 : 0}], unsavedDocuments: stateDirty ? [1] : []});
  const emit = data => {
    const event = new Event('message');
    Object.defineProperties(event, {origin: {value: origin}, source: {value: frame.contentWindow}, data: {value: data}});
    window.dispatchEvent(event);
  };
  const engine = {
    uiInspect: async () => state(), execute: async () => {},
    async request(method, args) {
      calls.push({method, args});
      if (method === 'engine.execute' && args.command === 'file.save') {
        const id = ++saveId;
        queueMicrotask(() => emit({type: 'wordcraft:save', id: 'wordcraft-save-' + id,
          documentId: '1', revision: '1', name: 'Test.docx', bytes: new ArrayBuffer(1),
          operation: 'file.save', saveAs: false, documentSave: true}));
        return {pendingSave: id};
      }
      return {method, ...args};
    }
  };
  const document = {body, createElement(tag) {
    const node = new Element();
    if (tag === 'iframe') { frame = node; node.contentWindow = {wordcraft: engine,
      postMessage(data) { if (data.type === 'wordcraft:saved') stateDirty = false; }}; }
    return node;
  }};
  const context = vm.createContext({document, window, location: {href: origin + '/', origin},
    URL, AbortController, DOMException, setTimeout, clearTimeout, structuredClone, Blob,
    ArrayBuffer, btoa, queueMicrotask});
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context});
  await module.link(specifier => {
    assert.equal(specifier, './style.css');
    return new vm.SyntheticModule([], () => {}, {context});
  });
  await module.evaluate();
  const view = module.namespace.mount({instanceId: 'view-1', sessionId: 'session-1', url: '/editor', authority,
    files: {check() {}, async write(path, bytes, previous) { writes.push({path, bytes, previous}); return {sha256: 'a'.repeat(64)}; }},
    authorize: async (candidate, request) => { decisions.push({candidate, request: structuredClone(request)}); return policy ? policy(candidate, request, authority) : candidate === authority; }});
  emit({type: 'wordcraft:ready'}); await view.ready; calls.length = 0; decisions.length = 0;
  return {view, authority, calls, decisions, writes, body, emit,
    request: {instanceId: 'view-1', sessionId: 'session-1', documentId: '1', resourceId: 'draft:1', command: 'text.insert', args: {text: 'authorized text'}}};
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
    bytes: new ArrayBuffer(1), operation: 'file.saveAs', saveAs: true, documentSave: true});
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
  const dialog = f.body.children.at(-1), save = dialog.children.find(node => node.textContent === 'Save');
  assert(save); save.dispatchEvent(new Event('click'));
  assert.equal(await closing, true); assert.equal(f.writes.length, 1);
  assert(f.decisions.every(row => row.candidate === f.authority));
  assert.equal(f.writes[0].path, 'Documents/Test.docx');
});
