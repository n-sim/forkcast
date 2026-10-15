import {
  validateRecipe,
  validateRecipeRating,
  type Recipe,
  type RecipeDraft,
  type RecipeRating,
} from './domain';

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('forkcast', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes'))
        db.createObjectStore('recipes', { keyPath: 'id' });
      db.createObjectStore('recipeCoverPhotos', { keyPath: 'recipeId' });
      db.createObjectStore('personalRecipeRatings', {
        keyPath: ['personId', 'recipeId'],
      }).createIndex('personId', 'personId');
      // Standalone has one person without login; sync can later map this identity
      // to an account without moving personal ratings into shared recipe data.
      db.createObjectStore('localSettings').put(
        crypto.randomUUID(),
        'personId',
      );
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Close other Forkcast tabs and try again.'));
  });
  return database;
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
        const recipes = (request.result as RecipeDraft[]).map((stored) => {
          const { recipe } = validateRecipe(stored);
          if (!recipe)
            throw new Error(
              'A saved recipe could not be read. Your stored data has been kept.',
            );
          return recipe;
        });
        resolve(recipes);
      } catch (error) {
        reject(error);
      }
    };
  });
}

export async function saveRecipe(recipe: Recipe): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('recipes', 'readwrite');
    transaction.objectStore('recipes').put(recipe);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
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

async function localPersonId(): Promise<string> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('localSettings', 'readonly');
    const request = transaction.objectStore('localSettings').get('personId');
    transaction.onabort = () => reject(transaction.error);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (typeof request.result === 'string' && request.result.trim())
        resolve(request.result);
      else
        reject(new Error('This device’s personal identity could not be read.'));
    };
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
