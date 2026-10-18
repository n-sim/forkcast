import { validateRecipe, type Recipe, type RecipeRating } from './domain';
import type { CookingSession } from './cooking';
import { CoreError, execute, subscribeToTopics } from './core';

// Recipes, ratings, and cooking sessions live in the application core. These
// functions are the frontend's view of them; nothing is stored here.

export interface WirePhoto {
  mime: string;
  data: string;
}

interface RecipeView {
  recipe: Recipe;
  coverPhoto: WirePhoto | null;
  revisionId: string;
  unresolved: number;
}

export function photoBlob(photo: WirePhoto): Blob {
  return new Blob(
    [Uint8Array.from(atob(photo.data), (character) => character.charCodeAt(0))],
    { type: photo.mime },
  );
}

export async function blobPhoto(photo: Blob): Promise<WirePhoto> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(photo);
  });
  return { mime: photo.type, data };
}

function toRecipe(view: RecipeView): Recipe {
  return { ...view.recipe, syncRevisionId: view.revisionId };
}

export async function loadRecipeCollection(): Promise<{
  recipes: Recipe[];
  photos: Record<string, Blob>;
}> {
  const views = await execute<RecipeView[]>('recipes');
  return {
    recipes: views.map(toRecipe),
    photos: Object.fromEntries(
      views
        .filter((view) => view.coverPhoto)
        .map((view) => [view.recipe.id, photoBlob(view.coverPhoto!)]),
    ),
  };
}

export async function loadRecipes(): Promise<Recipe[]> {
  return (await loadRecipeCollection()).recipes;
}

export async function loadRecipeCoverPhotos(): Promise<Record<string, Blob>> {
  return (await loadRecipeCollection()).photos;
}

export function subscribeToRecipeChanges(listener: () => void) {
  return subscribeToTopics(['recipes', 'ratings'], listener);
}

export async function saveRecipe(draft: Recipe): Promise<Recipe> {
  const { recipe } = validateRecipe(draft);
  if (!recipe) throw new Error('Check the recipe before saving.');
  const saved = await execute<{ current: RecipeView }>('saveRecipe', {
    recipe: draft,
    baseRevisionId: draft.syncRevisionId ?? null,
  });
  return toRecipe(saved.current);
}

// Cover photos are household recipe assets, separate from personal records.
export async function saveRecipeCoverPhoto(
  draft: Recipe,
  image: Blob | null,
): Promise<void> {
  await execute('setRecipeCoverPhoto', {
    recipeId: draft.id,
    coverPhoto: image ? await blobPhoto(image) : null,
    baseRevisionId: draft.syncRevisionId ?? null,
  });
}

export async function loadPersonalRecipeRatings(): Promise<
  Record<string, RecipeRating>
> {
  let ratings: { recipeId: string; value: number | null }[];
  try {
    ratings = await execute('ratings');
  } catch (failure) {
    // Private records stay hidden while signed out.
    if (failure instanceof CoreError && failure.kind === 'forbidden') return {};
    throw failure;
  }
  return Object.fromEntries(
    ratings
      .filter((rating) => rating.value !== null)
      .map((rating) => [
        rating.recipeId,
        {
          personId: 'self',
          recipeId: rating.recipeId,
          value: rating.value!,
        } satisfies RecipeRating,
      ]),
  );
}

export async function savePersonalRecipeRating(
  recipeId: string,
  value: number | null,
): Promise<RecipeRating | null> {
  await execute('rateRecipe', { recipeId, value });
  return value === null ? null : { personId: 'self', recipeId, value };
}

export async function loadCookingSessions(): Promise<CookingSession[]> {
  try {
    return await execute<CookingSession[]>('cookingSessions');
  } catch (failure) {
    if (failure instanceof CoreError && failure.kind === 'forbidden') return [];
    throw failure;
  }
}

export async function saveCookingSession(
  session: CookingSession,
): Promise<void> {
  await execute('saveCookingProgress', {
    sessionId: session.id,
    step: session.currentStep,
    timers: session.timers,
  });
}

export async function endCookingSession(
  id: string,
  outcome: 'finished' | 'canceled',
): Promise<void> {
  await execute('endCooking', { sessionId: id, outcome });
}

export function subscribeToCookingChanges(listener: () => void) {
  return subscribeToTopics(['cookingSessions'], listener);
}

/** Starts cooking the recipe as the core holds it now, unless the person still has unfinished sessions. */
export async function beginCookingSession(
  proposal: CookingSession,
  cancelSessionIds: string[] = [],
): Promise<{ session: CookingSession | null; conflicts: CookingSession[] }> {
  return execute('startCooking', {
    recipeId: proposal.recipe.id,
    portions: proposal.portions,
    displayUnits: proposal.displayUnits ?? null,
    cancelSessionIds,
  });
}

export interface RecipeHistory {
  recipeId: string;
  count: number;
  /** Milliseconds since the Unix epoch. */
  lastCookedAt: number;
}

/** The household's cooking count and last-cooked time per recipe. */
export async function loadCookingHistory(): Promise<
  Record<string, RecipeHistory>
> {
  const history = await execute<RecipeHistory[]>('cookingHistory');
  return Object.fromEntries(history.map((entry) => [entry.recipeId, entry]));
}

/** Records one cooking occurrence; repeating an `id` counts nothing more. */
export async function markRecipeCooked(
  recipeId: string,
  id: string,
  sessionId?: string,
): Promise<RecipeHistory> {
  return execute<RecipeHistory>('markCooked', { recipeId, id, sessionId });
}

export function subscribeToCookingHistoryChanges(listener: () => void) {
  return subscribeToTopics(['cookingHistory'], listener);
}
