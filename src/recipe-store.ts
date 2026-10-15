import {
  validateRecipe,
  validateRecipeRating,
  updateCookingProgress,
  type Recipe,
  type RecipeDraft,
  type RecipeRating,
} from './domain';
import type { CookingSession } from './cooking';
import { openDatabase, localPersonId } from './local-store';
import { recipeNutritionChange } from './nutrition';

export async function loadCookingSessions(): Promise<CookingSession[]> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('cookingSessions', 'readonly');
    const request = transaction
      .objectStore('cookingSessions')
      .index('personId')
      .getAll(personId);
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () =>
      resolve((request.result as CookingSession[]).filter(unfinishedCooking));
  });
}

export async function saveCookingSession(
  session: CookingSession,
): Promise<void> {
  await changeCookingSessions((sessions, store) => {
    const stored = sessions.find((item) => item.id === session.id);
    if (!stored)
      throw new Error(
        'This cooking session has ended or belongs to another person.',
      );
    store.put({
      ...stored,
      ...updateCookingProgress(
        stored,
        { type: 'step', step: session.currentStep },
        stored.recipe.steps.length,
        Date.now(),
      ),
      timers: session.timers,
    });
  });
}

function unfinishedCooking(session: CookingSession) {
  return session.completedAt == null && session.canceledAt == null;
}

// Reads and writes share one transaction, so simultaneous starts in different
// tabs cannot create two unfinished cooking sessions for the same person.
async function changeCookingSessions<T>(
  change: (
    sessions: CookingSession[],
    store: IDBObjectStore,
    personId: string,
  ) => T,
): Promise<T> {
  const personId = await localPersonId();
  const db = await openDatabase();
  const result = await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('cookingSessions', 'readwrite');
    const store = transaction.objectStore('cookingSessions');
    const request = store.index('personId').getAll(personId);
    let result: T;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        result = change(request.result as CookingSession[], store, personId);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error);
  });
  const channel = new BroadcastChannel('forkcast-cooking');
  channel.postMessage('changed');
  channel.close();
  return result;
}

export function subscribeToCookingChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-cooking');
  channel.onmessage = listener;
  return () => channel.close();
}

export async function beginCookingSession(
  session: CookingSession,
  cancelSessionIds: string[] = [],
): Promise<{ session: CookingSession | null; conflicts: CookingSession[] }> {
  return changeCookingSessions((sessions, store, personId) => {
    const unfinished = sessions.filter(unfinishedCooking);
    if (
      unfinished.length &&
      (unfinished.length !== cancelSessionIds.length ||
        unfinished.some((item) => !cancelSessionIds.includes(item.id)))
    ) {
      return { session: null, conflicts: unfinished };
    }
    for (const previous of unfinished)
      store.put({
        ...previous,
        ...updateCookingProgress(
          previous,
          { type: 'cancel' },
          previous.recipe.steps.length,
          Date.now(),
        ),
      });
    store.add({ ...session, personId });
    return { session, conflicts: [] };
  });
}

export async function endCookingSession(
  id: string,
  outcome: 'finished' | 'canceled',
): Promise<void> {
  await changeCookingSessions((sessions, store) => {
    const session = sessions.find((item) => item.id === id);
    if (!session)
      throw new Error(
        'This cooking session belongs to another person or is not saved on this device.',
      );
    store.put({
      ...session,
      ...updateCookingProgress(
        session,
        { type: outcome === 'finished' ? 'finish' : 'cancel' },
        session.recipe.steps.length,
        Date.now(),
      ),
    });
  });
}

export async function loadRecipes(): Promise<Recipe[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('recipes', 'readonly');
    const request = transaction.objectStore('recipes').getAll();
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        const recipes = (
          request.result as (RecipeDraft & { nutritionVersionId?: string })[]
        ).map((stored) => {
          const { recipe } = validateRecipe(stored);
          if (!recipe)
            throw new Error(
              'A saved recipe could not be read. Your stored data has been kept.',
            );
          return { ...recipe, nutritionVersionId: stored.nutritionVersionId };
        });
        resolve(recipes);
      } catch (error) {
        reject(error);
      }
    };
  });
}

export async function saveRecipe(draft: Recipe): Promise<Recipe> {
  const { recipe } = validateRecipe(draft);
  if (!recipe) throw new Error('Check the recipe before saving.');
  const db = await openDatabase();
  const saved = await new Promise<Recipe>((resolve, reject) => {
    const transaction = db.transaction(
      ['recipes', 'nutritionVersions'],
      'readwrite',
    );
    const recipes = transaction.objectStore('recipes');
    const previous = recipes.get(recipe.id);
    let saved: Recipe;
    let failure: unknown;
    previous.onsuccess = () => {
      try {
        const stored = previous.result as Recipe | undefined;
        const change = recipeNutritionChange(recipe, stored);
        const id =
          !change.changed && stored?.nutritionVersionId
            ? stored.nutritionVersionId
            : crypto.randomUUID();
        if (id !== stored?.nutritionVersionId)
          transaction
            .objectStore('nutritionVersions')
            .add({ id, recipeId: recipe.id, perPortion: change.perPortion });
        saved = { ...recipe, nutritionVersionId: id };
        recipes.put(saved);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  const channel = new BroadcastChannel('forkcast-recipes');
  channel.postMessage('changed');
  channel.close();
  return saved;
}

export function subscribeToRecipeChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-recipes');
  channel.onmessage = listener;
  return () => channel.close();
}

// Cover photos are household recipe assets, separate from personal records.
export async function loadRecipeCoverPhotos(): Promise<Record<string, Blob>> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('recipeCoverPhotos', 'readonly');
    const request = transaction.objectStore('recipeCoverPhotos').getAll();
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const photos = request.result as { recipeId: string; image: Blob }[];
      resolve(
        Object.fromEntries(
          photos.map((photo) => [photo.recipeId, photo.image]),
        ),
      );
    };
  });
}

export async function saveRecipeCoverPhoto(
  recipeId: string,
  image: Blob | null,
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('recipeCoverPhotos', 'readwrite');
    const store = transaction.objectStore('recipeCoverPhotos');
    if (image) store.put({ recipeId, image });
    else store.delete(recipeId);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadPersonalRecipeRatings(): Promise<
  Record<string, RecipeRating>
> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('personalRecipeRatings', 'readonly');
    const request = transaction
      .objectStore('personalRecipeRatings')
      .index('personId')
      .getAll(personId);
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        const ratings = (request.result as RecipeRating[]).map(
          validateRecipeRating,
        );
        resolve(
          Object.fromEntries(
            ratings.map((rating) => [rating.recipeId, rating]),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
  });
}

export async function savePersonalRecipeRating(
  recipeId: string,
  value: number | null,
): Promise<RecipeRating | null> {
  const personId = await localPersonId();
  const rating =
    value === null ? null : validateRecipeRating({ personId, recipeId, value });
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('personalRecipeRatings', 'readwrite');
    const store = transaction.objectStore('personalRecipeRatings');
    if (rating) store.put(rating);
    else store.delete([personId, recipeId]);
    transaction.oncomplete = () => resolve(rating);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
