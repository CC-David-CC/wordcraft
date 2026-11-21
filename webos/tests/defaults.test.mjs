import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULTS_PATH, MAX_DEFAULTS_BYTES, encodeDefaults, readDefaults, writeDefaults} from '../defaults.mjs';

const value = () => ({version: 1, styles: {styles: []}, majorFont: 'Source Serif 4', minorFont: 'Source Sans 3', themeColors: [[1, 2, 3]]});
const missing = () => Object.assign(Error('missing'), {status: 404});
const conflict = () => Object.assign(Error('conflict'), {status: 409});
function store() {
  let data = null, revision = null, folder = false;
  return {check() {}, async list(path) {return {entries: path === '' ? [{name:'Digital-Projects',directory:true}] : path === 'Digital-Projects' ? (folder ? [{name:'WordCraft',directory:true}] : []) : (data ? [{name:'defaults-v1.json',directory:false,bytes:data.byteLength}] : [])};},
    async read(path) {assert.equal(path, DEFAULTS_PATH); if (!data) throw missing(); return {data, sha256: revision};},
    async mkdir(path) {assert.equal(path, 'Digital-Projects/WordCraft'); folder = true;},
    async write(path, blob, previous) {assert.equal(path, DEFAULTS_PATH); assert.equal(previous, revision); data = new Uint8Array(await blob.arrayBuffer()); revision = (revision ? 'b' : 'a').repeat(64); return {sha256: revision};}};
}
test('defaults are server-backed and account capabilities remain separate', async () => {
  const a = store(), b = store(), check = () => {};
  assert.equal(await readDefaults(a, check), null);
  assert.equal((await writeDefaults(a, check, value())).committed, true);
  assert.deepEqual((await readDefaults(a, check)).value, value());
  assert.equal(await readDefaults(b, check), null);
  const changed = {...value(), majorFont: 'Inter'};
  await writeDefaults(a, check, changed);
  assert.deepEqual((await readDefaults(a, check)).value, changed);
});
test('only missing defaults use built-ins; corrupt, denied and unavailable stores fail explicitly', async () => {
  for (const status of [403, 409, 500]) await assert.rejects(readDefaults({async list() {throw Object.assign(Error('unavailable'), {status});}}, () => {}), /unavailable/);
  const a = store(); await writeDefaults(a, () => {}, value());
  a.read = async () => ({sha256:'a'.repeat(64),data:new TextEncoder().encode('{broken')});
  await assert.rejects(readDefaults(a, () => {}), SyntaxError);
  assert.throws(() => encodeDefaults({...value(), majorFont: 'x'.repeat(MAX_DEFAULTS_BYTES)}), /256 KiB/);
});
test('CAS conflicts, lost confirmations and ended sessions never claim a saved default', async () => {
  const a = store();
  a.write = async () => {throw conflict();};
  await assert.rejects(writeDefaults(a, () => {}, value()), /conflict/);
  a.write = async () => ({});
  await assert.rejects(writeDefaults(a, () => {}, value()), /did not confirm/);
  let valid = true;
  a.list = async () => {valid = false; return {entries:[]};};
  await assert.rejects(writeDefaults(a, () => {if (!valid) throw Error('session ended');}, value()), /session ended/);
});

test('a deleted optional settings parent uses built-ins and is created only for an explicit save; collisions are preserved', async () => {
  const a = store(), list = a.list, mkdir = a.mkdir;
  let parent = false;
  a.list = async path => {if (!parent && path === '') return {entries:[]}; return list(path);};
  a.mkdir = async path => {if (path === 'Digital-Projects') parent = true; else return mkdir(path);};
  assert.equal(await readDefaults(a, () => {}), null);
  assert.equal(parent, false, 'blank creation does not recreate user folders');
  await writeDefaults(a, () => {}, value());
  assert.deepEqual((await readDefaults(a, () => {})).value, value());
  a.list = async path => path === '' ? list(path) : {entries:[{name:'WordCraft',directory:false}]};
  await assert.rejects(writeDefaults(a, () => {}, value()), /occupied by a file/);
});

test('older accounts can read their existing settings and save newer defaults in the canonical folder', async () => {
  const check = () => {}, a = store(), list = a.list, read = a.read;
  const legacy = {...value(), majorFont: 'Legacy'};
  const data = encodeDefaults(legacy);
  a.list = async path => {
    if (path === '') return {entries:[{name:'Digital Projects',directory:true},{name:'Digital-Projects',directory:true}]};
    if (path === 'Digital Projects') return {entries:[{name:'WordCraft',directory:true}]};
    if (path === 'Digital Projects/WordCraft') return {entries:[{name:'defaults-v1.json',directory:false,bytes:data.length}]};
    return list(path);
  };
  a.read = async path => path === 'Digital Projects/WordCraft/defaults-v1.json' ? {sha256:'c'.repeat(64),data} : read(path);
  assert.deepEqual((await readDefaults(a, check)).value, legacy);
  assert.equal((await writeDefaults(a, check, value())).path, DEFAULTS_PATH);
  assert.deepEqual((await readDefaults(a, check)).value, value());
});
