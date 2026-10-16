import { openDatabase, localPersonId } from './local-store';
import { loadBackendConfig, type BackendConfig } from './backend-client';
import type { Recipe, RecipeRating } from './domain';
import type { NutritionVersion } from './nutrition';

export interface SyncBinding {
  url: string;
  householdId: string;
}

// This selects the local account cache; the backend independently authorizes
// the bearer session and stored owner on every request.
export function recipeSyncAccount(
  config: BackendConfig | null,
  binding?: SyncBinding,
): string | undefined {
  return binding &&
    config?.token &&
    config.url === binding.url &&
    config.householdId === binding.householdId
    ? config.accountId
    : undefined;
}
export interface RecipeRevision {
  id: string;
  parentId: string | null;
  recipe: Recipe;
  nutritionVersions: NutritionVersion[];
  coverPhoto: Blob | null;
  pending: boolean;
}
export interface RatingChange {
  id: string;
  personId: string;
  recipeId: string;
  value: number | null;
}
export const revisionStores = [
  'recipes',
  'nutritionVersions',
  'recipeCoverPhotos',
  'recipeRevisions',
];

// Called within the same transaction as the recipe/photo write. A local save
// cannot commit without its durable revision, even when the backend is down.
export function recordRecipeRevision(
  transaction: IDBTransaction,
  recipe: Recipe,
  parentId: string | null,
) {
  const photo = transaction.objectStore('recipeCoverPhotos').get(recipe.id);
  const versions = transaction.objectStore('nutritionVersions').getAll();
  versions.onsuccess = () => {
    transaction.objectStore('recipeRevisions').add({
      id: recipe.syncRevisionId!,
      parentId,
      recipe,
      nutritionVersions: (versions.result as NutritionVersion[]).filter(
        (version) => version.recipeId === recipe.id,
      ),
      coverPhoto: photo.result?.image ?? null,
      pending: true,
    } satisfies RecipeRevision);
  };
}

export function notifyRecipeChanges(pending = true) {
  window.dispatchEvent(
    new CustomEvent('forkcast-recipes', { detail: pending }),
  );
  const channel = new BroadcastChannel('forkcast-recipes');
  channel.postMessage(pending);
  channel.close();
}

export function subscribeToRecipeChanges(listener: (pending: boolean) => void) {
  const changed = (event: Event) =>
    listener((event as CustomEvent<boolean>).detail);
  window.addEventListener('forkcast-recipes', changed);
  const channel = new BroadcastChannel('forkcast-recipes');
  channel.onmessage = (event: MessageEvent<boolean>) => listener(event.data);
  return () => {
    window.removeEventListener('forkcast-recipes', changed);
    channel.close();
  };
}

export async function loadSyncState(personId?: string) {
  const db = await openDatabase();
  return new Promise<{
    binding?: SyncBinding;
    revisions: RecipeRevision[];
    ratings: RatingChange[];
    conflicts: number;
  }>((resolve, reject) => {
    const transaction = db.transaction(
      ['localSettings', 'recipeRevisions', 'ratingChanges'],
      'readonly',
    );
    const binding = transaction
      .objectStore('localSettings')
      .get('recipeSyncBinding');
    const conflicts = transaction
      .objectStore('localSettings')
      .get('recipeSyncConflicts');
    const revisions = transaction.objectStore('recipeRevisions').getAll();
    const ratings = transaction
      .objectStore('ratingChanges')
      .index('personId')
      .getAll(personId ?? 'signed-out');
    transaction.oncomplete = () =>
      resolve({
        binding: binding.result,
        revisions: revisions.result,
        ratings: ratings.result,
        conflicts: conflicts.result ?? 0,
      });
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function ratingPersonId() {
  const { binding } = await loadSyncState();
  if (!binding) return localPersonId();
  return recipeSyncAccount(loadBackendConfig(), binding) ?? 'signed-out';
}

export async function enableRecipeSync(
  config: BackendConfig,
  householdId: string,
  accountId: string,
) {
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [
        ...revisionStores,
        'localSettings',
        'personalRecipeRatings',
        'ratingChanges',
      ],
      'readwrite',
    );
    const settings = transaction.objectStore('localSettings');
    const previous = settings.get('recipeSyncBinding');
    let failure: Error | undefined;
    previous.onsuccess = () => {
      const binding = previous.result as SyncBinding | undefined;
      if (
        binding &&
        (binding.url !== config.url || binding.householdId !== householdId)
      ) {
        failure = new Error(
          'This device’s collection is linked to another household. Use a separate browser profile for another household.',
        );
        transaction.abort();
        return;
      }
      settings.put(
        { url: config.url, householdId } satisfies SyncBinding,
        'recipeSyncBinding',
      );
      if (binding) return;
      const recipes = transaction.objectStore('recipes').getAll();
      recipes.onsuccess = () => {
        for (const stored of recipes.result as Recipe[]) {
          if (stored.syncRevisionId) continue;
          const recipe = { ...stored, syncRevisionId: crypto.randomUUID() };
          transaction.objectStore('recipes').put(recipe);
          recordRecipeRevision(transaction, recipe, null);
        }
      };
      // Explicit opt-in adopts only this device's standalone ratings, once.
      const ratings = transaction
        .objectStore('personalRecipeRatings')
        .index('personId')
        .getAll(personId);
      ratings.onsuccess = () => {
        for (const rating of ratings.result as RecipeRating[]) {
          transaction
            .objectStore('personalRecipeRatings')
            .put({ ...rating, personId: accountId });
          transaction.objectStore('ratingChanges').put({
            ...rating,
            id: crypto.randomUUID(),
            personId: accountId,
          } satisfies RatingChange);
        }
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error);
  });
  notifyRecipeChanges();
}

export interface CollectionSnapshot {
  revisions: RecipeRevision[];
  current: { recipeId: string; revisionId: string; unresolved: number }[];
}

export async function applyRecipeSync(
  snapshot: CollectionSnapshot,
  personId: string,
  remoteRatings: { recipeId: string; value: number | null }[],
  sentRatings: RatingChange[],
) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [
        ...revisionStores,
        'personalRecipeRatings',
        'ratingChanges',
        'localSettings',
      ],
      'readwrite',
    );
    const revisions = transaction.objectStore('recipeRevisions').getAll();
    const recipes = transaction.objectStore('recipes').getAll();
    const ratings = transaction
      .objectStore('personalRecipeRatings')
      .index('personId')
      .getAll(personId);
    const changes = transaction
      .objectStore('ratingChanges')
      .index('personId')
      .getAll(personId);
    changes.onsuccess = () => {
      const known = new Map(
        snapshot.revisions.map((revision) => [revision.id, revision]),
      );
      const pending = new Set(
        (revisions.result as RecipeRevision[])
          .filter((revision) => revision.pending && !known.has(revision.id))
          .map((revision) => revision.id),
      );
      const local = new Map(
        (recipes.result as Recipe[]).map((recipe) => [recipe.id, recipe]),
      );
      for (const revision of snapshot.revisions) {
        transaction
          .objectStore('recipeRevisions')
          .put({ ...revision, pending: false });
        for (const version of revision.nutritionVersions)
          transaction.objectStore('nutritionVersions').put(version);
      }
      for (const current of snapshot.current) {
        if (pending.has(local.get(current.recipeId)?.syncRevisionId ?? ''))
          continue;
        const revision = known.get(current.revisionId)!;
        transaction
          .objectStore('recipes')
          .put({ ...revision.recipe, syncRevisionId: revision.id });
        if (revision.coverPhoto)
          transaction
            .objectStore('recipeCoverPhotos')
            .put({ recipeId: current.recipeId, image: revision.coverPhoto });
        else
          transaction.objectStore('recipeCoverPhotos').delete(current.recipeId);
      }
      const outstanding = (changes.result as RatingChange[]).filter(
        (change) => !sentRatings.some((sent) => sent.id === change.id),
      );
      for (const sent of sentRatings) {
        if (
          !(changes.result as RatingChange[]).some(
            (change) =>
              change.recipeId === sent.recipeId && change.id !== sent.id,
          )
        )
          transaction
            .objectStore('ratingChanges')
            .delete([personId, sent.recipeId]);
      }
      const pendingRecipes = new Set(
        outstanding.map((change) => change.recipeId),
      );
      for (const rating of ratings.result as RecipeRating[]) {
        if (!pendingRecipes.has(rating.recipeId))
          transaction
            .objectStore('personalRecipeRatings')
            .delete([personId, rating.recipeId]);
      }
      for (const rating of remoteRatings) {
        if (rating.value !== null && !pendingRecipes.has(rating.recipeId))
          transaction
            .objectStore('personalRecipeRatings')
            .put({ ...rating, personId });
      }
      transaction.objectStore('localSettings').put(
        snapshot.current.reduce((sum, recipe) => sum + recipe.unresolved, 0),
        'recipeSyncConflicts',
      );
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  notifyRecipeChanges(false);
}
