/** Account-backed blank-document formatting. No browser-global fallback. */
export const DEFAULTS_PATH = 'Digital Projects/WordCraft/defaults-v1.json';
export const MAX_DEFAULTS_BYTES = 256 * 1024;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function encodeDefaults(value) {
  if (!value || value.version !== 1 || !value.styles || typeof value.majorFont !== 'string' || typeof value.minorFont !== 'string' || !Array.isArray(value.themeColors)) throw Error('Invalid WordCraft default formatting.');
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_DEFAULTS_BYTES) throw Error('WordCraft default formatting exceeds 256 KiB.');
  return bytes;
}

export async function readDefaults(files, check) {
  return (await load(files, check)).record;
}

async function load(files, check) {
  check();
  let parent;
  try { parent = await files.list('Digital Projects'); }
  catch (error) { check(); if (error.status === 404) return {parent: false, folder: false, record: null}; throw error; }
  check();
  if (!Array.isArray(parent?.entries)) throw Error('Invalid defaults folder listing.');
  const folder = parent.entries.find(entry => entry.name === 'WordCraft');
  if (!folder) return {parent: true, folder: false, record: null};
  if (!folder.directory) throw Error('The WordCraft settings location is occupied by a file.');
  const listing = await files.list('Digital Projects/WordCraft'); check();
  if (!Array.isArray(listing?.entries)) throw Error('Invalid defaults file listing.');
  const item = listing.entries.find(entry => entry.name === 'defaults-v1.json');
  if (!item) return {parent: true, folder: true, record: null};
  if (item.directory || item.bytes > MAX_DEFAULTS_BYTES) throw Error('Invalid WordCraft defaults file.');
  const file = await files.read(DEFAULTS_PATH);
  check();
  if (!digest(file?.sha256)) throw Error('Invalid default-formatting revision.');
  const bytes = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : file.data;
  check();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DEFAULTS_BYTES) throw Error('WordCraft default formatting exceeds 256 KiB.');
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  encodeDefaults(value);
  return {parent: true, folder: true, record: {value, sha256: file.sha256}};
}

export async function writeDefaults(files, check, value, {signal} = {}) {
  const bytes = encodeDefaults(value);
  // Read before the write and use the observed revision. A concurrent writer
  // produces a conflict rather than silently losing another window's defaults.
  const previous = await load(files, check);
  if (!previous.parent) {
    check(); await files.mkdir('Digital Projects'); check();
  }
  if (!previous.folder) {
    check();
    await files.mkdir('Digital Projects/WordCraft');
    check();
  }
  const result = await files.write(DEFAULTS_PATH, new Blob([bytes], {type: 'application/json'}), previous.record?.sha256 ?? null, {signal});
  check();
  if (!digest(result?.sha256)) throw Error('The server did not confirm the default-formatting save.');
  return {status: 'saved', path: DEFAULTS_PATH, sha256: result.sha256, committed: true};
}
