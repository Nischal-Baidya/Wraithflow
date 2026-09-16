import { supabase, TABLES } from './supabase-client.js';
import { getLocal, getMeta, getPhotoBlob, listConflicts, listMutations, putLocal, putManyLocal, removeMutation, saveConflict, setMeta } from './db.js';

const ownerColumn = (table) => table === 'profiles' ? 'id' : 'user_id';
let activeUserId;
let isRunning = false;
let changeListener = () => {};

export function configureSync(userId, onChange) { activeUserId = userId; changeListener = onChange || (() => {}); }
const emit = (state, detail = {}) => changeListener({ state, ...detail });

async function cloudRow(table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function recordConflict(mutation, cloud, reason) {
  const local = await getLocal(mutation.table, mutation.recordId);
  await saveConflict({ table: mutation.table, recordId: mutation.recordId, local, cloud, mutation, reason });
  emit('conflict');
}

async function pushMutation(mutation) {
  if (mutation.kind === 'photo_upload') {
    const photo = await getPhotoBlob(mutation.photoId);
    if (!photo?.blob) throw new Error('The offline photo is no longer available on this device.');
    const { error } = await supabase.storage.from('journal-photos').upload(mutation.path, photo.blob, { contentType: photo.type, upsert: false });
    if (error && error.status !== 409 && !/already exists/i.test(error.message)) throw error;
    const { data, error: insertError } = await supabase.from('journal_photos').insert(mutation.record).select().single();
    if (insertError) { await recordConflict({ ...mutation, table: 'journal_photos', recordId: mutation.record.id }, await cloudRow('journal_photos', mutation.record.id), 'photo_metadata_insert_failed'); return false; }
    await putLocal('journal_photos', data); return true;
  }
  if (mutation.kind === 'photo_delete') {
    const current = await cloudRow('journal_photos', mutation.recordId);
    if (!current || current.deleted_at) return true;
    const { data, error } = await supabase.from('journal_photos').update({ deleted_at: mutation.deletedAt }).eq('id', mutation.recordId).eq('updated_at', mutation.baseUpdatedAt).select();
    if (error) throw error;
    if (!data?.length) { await recordConflict(mutation, await cloudRow('journal_photos', mutation.recordId), 'photo_delete_version_mismatch'); return false; }
    const { error: storageError } = await supabase.storage.from('journal-photos').remove([mutation.path]);
    if (storageError) throw storageError;
    await putLocal('journal_photos', data[0]); return true;
  }

  if (mutation.kind === 'create') {
    const { data, error } = await supabase.from(mutation.table).insert(mutation.payload).select().single();
    if (error) {
      await recordConflict(mutation, await cloudRow(mutation.table, mutation.recordId), 'create_failed_or_duplicate');
      return false;
    }
    await putLocal(mutation.table, data); return true;
  }

  const payload = mutation.kind === 'soft_delete' ? { deleted_at: mutation.deletedAt } : mutation.payload;
  const { data, error } = await supabase.from(mutation.table).update(payload)
    .eq('id', mutation.recordId).eq('updated_at', mutation.baseUpdatedAt).select();
  if (error) throw error;
  if (!data?.length) { await recordConflict(mutation, await cloudRow(mutation.table, mutation.recordId), 'version_mismatch'); return false; }
  await putLocal(mutation.table, data[0]); return true;
}

export async function pullRemote() {
  if (!activeUserId) return;
  const mutations = await listMutations();
  const protectedKeys = new Set(mutations.map((item) => `${item.table}:${item.recordId}`));
  for (const table of TABLES) {
    let from = 0; const rows = [];
    while (true) {
      const { data, error } = await supabase.from(table).select('*').eq(ownerColumn(table), activeUserId).order('updated_at', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    const safe = [];
    for (const row of rows) {
      if (!protectedKeys.has(`${table}:${row.id}`)) safe.push(row);
      else {
        const local = await getLocal(table, row.id);
        if (local?.updated_at && local.updated_at !== row.updated_at) await saveConflict({ table, recordId: row.id, local, cloud: row, reason: 'cloud_changed_while_local_edit_pending' });
      }
    }
    await putManyLocal(table, safe);
    await setMeta(`lastPull:${table}`, new Date().toISOString());
  }
}

export async function synchronize({ pullFirst = true } = {}) {
  if (!activeUserId || isRunning || !navigator.onLine) return;
  isRunning = true; emit('syncing');
  try {
    if (pullFirst) await pullRemote();
    for (const mutation of await listMutations()) {
      const delivered = await pushMutation(mutation);
      if (delivered) await removeMutation(mutation.id);
      else await removeMutation(mutation.id); // a preserved conflict replaces automatic retry
    }
    await pullRemote();
    await setMeta('lastSuccessfulSync', new Date().toISOString());
    emit('synced', { conflicts: (await listConflicts()).length });
  } catch (error) {
    console.error('WraithFlow sync error', error);
    emit('error', { error });
  } finally { isRunning = false; }
}

export async function resolveConflict(conflict, resolution) {
  if (resolution === 'cloud') {
    if (conflict.cloud) await putLocal(conflict.table, conflict.cloud);
    return;
  }
  // Keeping local creates a new conditional update based on the observed cloud version;
  // it never overwrites an unseen newer server version.
  const local = conflict.local;
  if (!local) return;
  const payload = { ...local }; delete payload.created_at; delete payload.updated_at;
  const { queueMutation } = await import('./db.js');
  await queueMutation({ table: conflict.table, recordId: local.id, kind: 'update', payload, baseUpdatedAt: conflict.cloud?.updated_at });
}

export function startSyncListeners() {
  window.addEventListener('online', () => synchronize());
  window.addEventListener('focus', () => synchronize());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synchronize(); });
}
