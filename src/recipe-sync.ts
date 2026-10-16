import {
  backendRequest,
  loadBackendConfig,
  type BackendConfig,
} from './backend-client';
import {
  applyRecipeSync,
  loadSyncState,
  recipeSyncAccount,
  type CollectionSnapshot,
  type RecipeRevision,
  type RatingChange,
  type RecipeConflict,
} from './recipe-sync-store';

interface WireRevision extends Omit<RecipeRevision, 'coverPhoto' | 'pending'> {
  coverPhoto: { mime: string; data: string } | null;
}

async function encodePhoto(
  photo: Blob | null,
): Promise<WireRevision['coverPhoto']> {
  if (!photo) return null;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(photo);
  });
  return { mime: photo.type, data };
}

function decodeRevision(revision: WireRevision): RecipeRevision {
  const photo = revision.coverPhoto;
  return {
    ...revision,
    pending: false,
    coverPhoto: photo
      ? new Blob(
          [
            Uint8Array.from(atob(photo.data), (character) =>
              character.charCodeAt(0),
            ),
          ],
          { type: photo.mime },
        )
      : null,
  };
}

function requireConnection(config: BackendConfig) {
  const current = loadBackendConfig();
  if (current?.url !== config.url || current.token !== config.token)
    throw new Error('Account changed. Pending changes stay on this device.');
}

export async function synchronizeRecipes(config: BackendConfig) {
  // Serialize tabs without holding an IndexedDB transaction across network I/O.
  await navigator.locks.request('forkcast-recipe-sync', async () => {
    requireConnection(config);
    const state = await loadSyncState(config.accountId);
    const accountId = recipeSyncAccount(config, state.binding);
    if (!accountId || !state.binding) return;
    const householdPath = `/households/${encodeURIComponent(state.binding.householdId)}`;
    const accountPath = `/accounts/${encodeURIComponent(accountId)}/recipe-ratings`;
    const pending = new Map(
      state.revisions
        .filter((revision) => revision.pending)
        .map((revision) => [revision.id, revision]),
    );
    while (pending.size) {
      const next = [...pending.values()].find(
        (revision) => !revision.parentId || !pending.has(revision.parentId),
      );
      if (!next)
        throw new Error(
          'Pending recipe revisions could not be ordered. Your changes have been kept.',
        );
      const revision: WireRevision = {
        id: next.id,
        parentId: next.parentId,
        recipe: next.recipe,
        nutritionVersions: next.nutritionVersions,
        coverPhoto: await encodePhoto(next.coverPhoto),
      };
      requireConnection(config);
      await backendRequest(
        config,
        `${householdPath}/recipe-revisions`,
        'POST',
        revision,
      );
      pending.delete(next.id);
    }
    requireConnection(config);
    if (state.ratings.length)
      await backendRequest(config, accountPath, 'POST', {
        changes: state.ratings.map(({ id, recipeId, value }) => ({
          id,
          recipeId,
          value,
        })),
      });
    const [collection, ratings] = await Promise.all([
      backendRequest<
        Omit<CollectionSnapshot, 'revisions'> & { revisions: WireRevision[] }
      >(config, `${householdPath}/recipes`),
      backendRequest<Pick<RatingChange, 'recipeId' | 'value'>[]>(
        config,
        accountPath,
      ),
    ]);
    requireConnection(config);
    await applyRecipeSync(
      { ...collection, revisions: collection.revisions.map(decodeRevision) },
      accountId,
      ratings,
      state.ratings,
    );
  });
}

export async function chooseCurrentRecipe(
  config: BackendConfig,
  conflict: RecipeConflict,
  revisionId: string,
) {
  // Upload any local edits first, so they also participate in the server's check.
  await synchronizeRecipes(config);
  await navigator.locks.request('forkcast-recipe-sync', async () => {
    requireConnection(config);
    await backendRequest(
      config,
      `/households/${encodeURIComponent(config.householdId!)}/recipes/${encodeURIComponent(conflict.recipeId)}/current`,
      'POST',
      {
        revisionId,
        expectedRevisionIds: conflict.revisions.map((revision) => revision.id),
      },
    );
    requireConnection(config);
  });
  await synchronizeRecipes(config);
}
