import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureDraft, createDraftJournal} from '../drafts.mjs';
const draft = data => ({path:'Documents/Report.docx',revision:'a'.repeat(64),snapshot:{version:1,data,revision:'17'}});
function store() {
  const rows=new Map(), writes=[];
  return {rows,writes,async get(id){return structuredClone(rows.get(id));},
    async put(id,value){const generation=crypto.randomUUID();rows.set(id,{...structuredClone(value),id,generation});writes.push(value);return generation;},
    async remove(id,generation){if(generation&&rows.get(id)?.generation!==generation)return false;return rows.delete(id);}};
}
test('a rich snapshot retains native data and confirmed base revision without retaining extra secrets',()=>{
  const value=draft('{"heading":"example","styles":{},"images":[]}');value.token='synthetic-not-for-storage';value.snapshot.password='also-not-for-storage';
  assert.deepEqual(captureDraft(value),draft(value.snapshot.data));
});
test('queued rich captures are immutable and discard cannot resurrect an older write',async()=>{
  const s=store(),j=createDraftJournal({store:s}),value=draft('first');const first=j.write(value);value.snapshot.data='changed';
  const second=j.write(draft('second')),clear=j.clear();await Promise.all([first,second,clear]);
  assert.deepEqual(s.writes.map(v=>v.snapshot.data),['first','second']);assert.equal(s.rows.size,0);
});
test('a newer edit after acknowledgement retains its new path/revision recovery snapshot',async()=>{
  const s=store(),j=createDraftJournal({store:s});await j.write(draft('old'));
  const next=draft('newer');next.path='Documents/Copy.docx';next.revision='b'.repeat(64);
  await Promise.all([j.clear(),j.write(next)]);assert.deepEqual(s.writes.at(-1),next);assert.equal(s.rows.size,1);
});
test('recovery uses a fresh writer and cannot erase a concurrently updated source',async()=>{
  const s=store(),id=crypto.randomUUID();await s.put(id,draft('captured'));const j=createDraftJournal({store:s,sourceId:id});
  assert.equal((await j.load()).snapshot.data,'captured');await s.put(id,draft('other live view'));await j.write(draft('recovered'));
  assert.equal(s.rows.get(id).snapshot.data,'other live view');assert.equal(s.rows.size,2);
});
test('invalid identities/formats are refused and unbound drafts remain distinct from account files',()=>{
  for(const value of [draft('x'),draft('x'),draft('x')].map((v,i)=>{if(i===0)v.path='../Report.docx';if(i===1)v.snapshot.version=2;if(i===2)v.revision=null;return v;}))assert.throws(()=>captureDraft(value),/Invalid/);
  assert.deepEqual(captureDraft({path:null,revision:null,snapshot:{version:1,data:'rich',revision:'4'}}),{path:null,revision:null,snapshot:{version:1,data:'rich',revision:'4'}});
});
