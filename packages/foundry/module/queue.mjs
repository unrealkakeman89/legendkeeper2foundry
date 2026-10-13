const DB_NAME = "legendkeeper-offline";
const STORE = "operations";

export function openOfflineQueue(indexedDBImpl = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(queueFromDb(request.result));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function queueFromDb(db) {
  function run(mode, fn) {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    return requestToPromise(fn(store));
  }
  return {
    async enqueue(operation) {
      const record = {
        id: operation.id,
        state: "pending",
        error: "",
        change: operation.change,
        createdAt: new Date().toISOString()
      };
      await run("readwrite", (store) => store.put(record));
      return record;
    },
    async list() {
      const rows = await run("readonly", (store) => store.getAll());
      return rows.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
    },
    async mark(id, state, error = "") {
      const current = await run("readonly", (store) => store.get(id));
      if (!current) return null;
      const next = { ...current, state, error };
      await run("readwrite", (store) => store.put(next));
      return next;
    },
    close() {
      db.close();
    }
  };
}
