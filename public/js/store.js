// The on-device library of scanned pages, kept in IndexedDB so a page (and
// every word analysis already paid for) can be reopened without the network.

const DB_NAME = "translatinate";
const STORE = "scans";
const MAX_SCANS = 50;

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getScan(id) {
  return run("readonly", (store) => store.get(id));
}

export async function listScans() {
  const scans = (await run("readonly", (store) => store.getAll())) ?? [];
  return scans.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteScan(id) {
  return run("readwrite", (store) => store.delete(id));
}

export async function saveScan(scan) {
  await run("readwrite", (store) => store.put(scan));
  const scans = await listScans();
  for (const old of scans.slice(MAX_SCANS)) await deleteScan(old.id);
}
