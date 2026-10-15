import { openDatabase, localPersonId } from './local-store';
import {
  validateManualFoodLogEntry,
  type ManualFoodLogEntry,
} from './food-log';

export async function loadFoodLog(): Promise<{
  entries: ManualFoodLogEntry[];
  date: string | undefined;
}> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      ['manualFoodLogEntries', 'localSettings'],
      'readonly',
    );
    const entries = transaction
      .objectStore('manualFoodLogEntries')
      .index('personId')
      .getAll(personId);
    const date = transaction
      .objectStore('localSettings')
      .get(['foodLogDate', personId]);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () =>
      resolve({
        entries: entries.result as ManualFoodLogEntry[],
        date: date.result as string | undefined,
      });
  });
}

export async function saveManualFoodLogEntry(
  draft: ManualFoodLogEntry,
): Promise<void> {
  const { entry } = validateManualFoodLogEntry(draft);
  if (!entry) throw new Error('Check the food-log entry before saving.');
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ['manualFoodLogEntries', 'localSettings'],
      'readwrite',
    );
    transaction.objectStore('manualFoodLogEntries').add({ ...entry, personId });
    transaction
      .objectStore('localSettings')
      .put(entry.consumedAt.slice(0, 10), ['foodLogDate', personId]);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  const channel = new BroadcastChannel('forkcast-food-log');
  channel.postMessage('changed');
  channel.close();
}

export async function saveFoodLogDate(date: string): Promise<void> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('localSettings', 'readwrite');
    transaction
      .objectStore('localSettings')
      .put(date, ['foodLogDate', personId]);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export function subscribeToFoodLogChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-food-log');
  channel.onmessage = listener;
  return () => channel.close();
}
