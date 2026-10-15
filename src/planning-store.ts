import { openDatabase, localPersonId } from './local-store';
import { validatePlannedCooking, type PlannedCooking } from './planning';

export async function loadPlannedCookings(): Promise<PlannedCooking[]> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('plannedCookings', 'readonly');
    const request = transaction
      .objectStore('plannedCookings')
      .index('personId')
      .getAll(personId);
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        resolve(
          (request.result as PlannedCooking[]).map((stored) => {
            const { cooking } = validatePlannedCooking(stored);
            if (!cooking)
              throw new Error(
                'A saved planned cooking could not be read. Your stored data has been kept.',
              );
            return cooking;
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
  });
}

export async function savePlannedCooking(draft: PlannedCooking): Promise<void> {
  const { cooking } = validatePlannedCooking(draft);
  if (!cooking) throw new Error('Check the planned cooking before saving.');
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ['plannedCookings', 'recipes'],
      'readwrite',
    );
    const store = transaction.objectStore('plannedCookings');
    const previous = store.get(cooking.id);
    const recipe = transaction.objectStore('recipes').get(cooking.recipeId);
    let failure: Error | undefined;
    recipe.onsuccess = () => {
      if (
        !recipe.result ||
        (previous.result && previous.result.personId !== personId)
      ) {
        failure = new Error('Choose a current recipe for your personal plan.');
        transaction.abort();
        return;
      }
      store.put({ ...cooking, personId });
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  const channel = new BroadcastChannel('forkcast-planning');
  channel.postMessage('changed');
  channel.close();
}

export function subscribeToPlanningChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-planning');
  channel.onmessage = listener;
  return () => channel.close();
}
