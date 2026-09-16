const VERSION = 1;
const STORES = ['profiles', 'habits', 'habit_entries', 'goals', 'goal_milestones', 'planner_tasks', 'journal_entries', 'journal_photos'];
let database;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function openLocalDatabase(userId) {
  if (database) database.close();
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(`wraithflow:${userId}`, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('updated_at', 'updated_at');
          store.createIndex('deleted_at', 'deleted_at');
        }
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'id' });
        store.createIndex('state', 'state'); store.createIndex('entity', ['table', 'recordId']);
      }
      if (!db.objectStoreNames.contains('conflicts')) {
        const store = db.createObjectStore('conflicts', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at'); store.createIndex('entity', ['table', 'recordId']);
      }
      if (!db.objectStoreNames.contains('photo_blobs')) db.createObjectStore('photo_blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

function store(name, mode = 'readonly') { return database.transaction(name, mode).objectStore(name); }
export async function getLocal(table, id) { return requestAsPromise(store(table).get(id)); }
export async function listLocal(table) { return requestAsPromise(store(table).getAll()); }
export async function putLocal(table, record) { return requestAsPromise(store(table, 'readwrite').put(record)); }
export async function deleteLocal(table, id) { return requestAsPromise(store(table, 'readwrite').delete(id)); }

export async function putManyLocal(table, records) {
  if (!records?.length) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(table, 'readwrite'); const target = transaction.objectStore(table);
    records.forEach((record) => target.put(record)); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
}

export async function getMeta(key) { return (await requestAsPromise(store('meta').get(key)))?.value; }
export async function setMeta(key, value) { return requestAsPromise(store('meta', 'readwrite').put({ key, value })); }

export async function queueMutation(mutation) {
  const item = { id: crypto.randomUUID(), state: 'pending', queuedAt: new Date().toISOString(), ...mutation };
  await requestAsPromise(store('outbox', 'readwrite').put(item)); return item;
}
export async function listMutations() { return (await requestAsPromise(store('outbox').getAll())).filter((item) => item.state === 'pending').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)); }
export async function removeMutation(id) { return requestAsPromise(store('outbox', 'readwrite').delete(id)); }
export async function replaceMutation(item) { return requestAsPromise(store('outbox', 'readwrite').put(item)); }

export async function saveConflict(conflict) { return requestAsPromise(store('conflicts', 'readwrite').put({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...conflict })); }
export async function listConflicts() { return (await requestAsPromise(store('conflicts').getAll())).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export async function removeConflict(id) { return requestAsPromise(store('conflicts', 'readwrite').delete(id)); }
export async function putPhotoBlob(item) { return requestAsPromise(store('photo_blobs', 'readwrite').put(item)); }
export async function getPhotoBlob(id) { return requestAsPromise(store('photo_blobs').get(id)); }
export async function removePhotoBlob(id) { return requestAsPromise(store('photo_blobs', 'readwrite').delete(id)); }

export async function clearLocalUserData() {
  if (!database) return;
  const names = [...STORES, 'outbox', 'conflicts', 'photo_blobs', 'meta'];
  await Promise.all(names.map((name) => requestAsPromise(store(name, 'readwrite').clear())));
}
