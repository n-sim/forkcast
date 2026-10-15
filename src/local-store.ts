let database: Promise<IDBDatabase> | undefined;

export function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('forkcast', 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes'))
        db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recipeCoverPhotos'))
        db.createObjectStore('recipeCoverPhotos', { keyPath: 'recipeId' });
      if (!db.objectStoreNames.contains('personalRecipeRatings'))
        db.createObjectStore('personalRecipeRatings', {
          keyPath: ['personId', 'recipeId'],
        }).createIndex('personId', 'personId');
      // Standalone has one person; later sync can explicitly map this identity
      // to an account without merging personal data into household recipes.
      if (!db.objectStoreNames.contains('localSettings'))
        db.createObjectStore('localSettings').put(
          crypto.randomUUID(),
          'personId',
        );
      if (!db.objectStoreNames.contains('cookingSessions'))
        db.createObjectStore('cookingSessions', { keyPath: 'id' }).createIndex(
          'personId',
          'personId',
        );
      if (!db.objectStoreNames.contains('manualFoodLogEntries'))
        db.createObjectStore('manualFoodLogEntries', {
          keyPath: 'id',
        }).createIndex('personId', 'personId');
      if (!db.objectStoreNames.contains('plannedCookings'))
        db.createObjectStore('plannedCookings', { keyPath: 'id' }).createIndex(
          'personId',
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

export async function localPersonId(): Promise<string> {
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
