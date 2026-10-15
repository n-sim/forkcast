import { openDatabase, localPersonId } from './local-store';
import {
  validateManualFoodLogEntry,
  validateRecipeFoodLogEntry,
  dailyFoodLog,
  type FoodLogData,
  type ManualFoodLogEntry,
  type RecipeFoodLogEntry,
} from './food-log';

export async function loadFoodLog(): Promise<FoodLogData> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [
        'manualFoodLogEntries',
        'recipeFoodLogEntries',
        'nutritionVersions',
        'localSettings',
      ],
      'readonly',
    );
    const entries = transaction
      .objectStore('manualFoodLogEntries')
      .index('personId')
      .getAll(personId);
    const date = transaction
      .objectStore('localSettings')
      .get(['foodLogDate', personId]);
    const recipeEntries = transaction
      .objectStore('recipeFoodLogEntries')
      .index('personId')
      .getAll(personId);
    const nutritionVersions = transaction
      .objectStore('nutritionVersions')
      .getAll();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () =>
      resolve({
        entries: entries.result as ManualFoodLogEntry[],
        date: date.result as string | undefined,
        recipeEntries: recipeEntries.result,
        nutritionVersions: nutritionVersions.result,
      });
  });
}

export async function saveRecipeFoodLogEntry(
  draft: RecipeFoodLogEntry,
): Promise<void> {
  const { entry } = validateRecipeFoodLogEntry(draft);
  if (!entry) throw new Error('Check the food-log entry before saving.');
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ['recipes', 'recipeFoodLogEntries', 'nutritionVersions', 'localSettings'],
      'readwrite',
    );
    const recipe = transaction.objectStore('recipes').get(entry.recipeId);
    const version = transaction
      .objectStore('nutritionVersions')
      .get(entry.nutritionVersionId);
    let failure: unknown;
    version.onsuccess = () => {
      try {
        if (!recipe.result)
          throw new Error('This recipe is no longer available for logging.');
        // Resolve through the shared calculation before saving, including range
        // checks and the version's relationship to this recipe.
        dailyFoodLog(
          {
            entries: [],
            recipeEntries: [entry],
            nutritionVersions: version.result ? [version.result] : [],
          },
          entry.consumedAt.slice(0, 10),
        );
        transaction
          .objectStore('recipeFoodLogEntries')
          .add({ ...entry, personId });
        transaction
          .objectStore('localSettings')
          .put(entry.consumedAt.slice(0, 10), ['foodLogDate', personId]);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  const channel = new BroadcastChannel('forkcast-food-log');
  channel.postMessage('changed');
  channel.close();
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
