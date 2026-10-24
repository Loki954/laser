// Tiny IndexedDB key/value wrapper + localStorage helpers (all failures are non-fatal)
const DB = 'sculpfun-studio';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'fonts', 'images']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store).objectStore(store).get(key); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}
export async function idbSet(store, key, val) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function idbDel(store, key) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function idbKeys(store) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store).objectStore(store).getAllKeys(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}

export function lsGet(key, def) {
  try { const v = localStorage.getItem('sfs.' + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
}
export function lsSet(key, val) {
  try { localStorage.setItem('sfs.' + key, JSON.stringify(val)); } catch (e) { }
}
