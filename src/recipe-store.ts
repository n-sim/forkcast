import { validateRecipe, type Recipe, type RecipeDraft } from './domain';

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('forkcast', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('recipes', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
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
