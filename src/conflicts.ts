import { execute, subscribeToTopics } from './core';
import type { Recipe } from './domain';
import { photoBlob, type WirePhoto } from './recipe-store';
import { loadPlanningSnapshot, type PlanningSnapshot } from './planning-store';
import { useEffect, useState } from 'react';

export interface RecipeRevision {
  id: string;
  parentId: string | null;
  recipe: Recipe;
  coverPhoto: Blob | null;
}

export interface RecipeConflict {
  recipeId: string;
  currentRevisionId: string;
  revisions: RecipeRevision[];
}

interface Collection {
  revisions: (Omit<RecipeRevision, 'coverPhoto'> & {
    coverPhoto: WirePhoto | null;
  })[];
  current: {
    recipeId: string;
    revisionId: string;
    unresolved: number;
    competingRevisionIds?: string[];
  }[];
}

/** Recipes edited separately, with every competing revision retained. */
export async function loadRecipeConflicts(): Promise<RecipeConflict[]> {
  const collection = await execute<Collection>('recipeCollection');
  const revisions = new Map(
    collection.revisions.map((revision) => [
      revision.id,
      {
        ...revision,
        coverPhoto: revision.coverPhoto ? photoBlob(revision.coverPhoto) : null,
      },
    ]),
  );
  return collection.current
    .filter((current) => current.unresolved > 0)
    .map((current) => ({
      recipeId: current.recipeId,
      currentRevisionId: current.revisionId,
      revisions: (current.competingRevisionIds ?? [])
        .map((id) => revisions.get(id)!)
        .filter(Boolean),
    }));
}

export async function chooseCurrentRecipe(
  conflict: RecipeConflict,
  revisionId: string,
): Promise<void> {
  await execute('chooseCurrentRecipe', {
    recipeId: conflict.recipeId,
    revisionId,
    expectedRevisionIds: conflict.revisions.map((revision) => revision.id),
  });
}

const emptyPlanning: PlanningSnapshot = {
  revision: null,
  data: { cookings: {}, shoppingList: null },
  conflicts: [],
};

/** Unresolved competing recipe edits and planning changes, reloaded as they change. */
export function useConflicts(enabled: boolean) {
  const [recipes, setRecipes] = useState<RecipeConflict[]>([]);
  const [planning, setPlanning] = useState<PlanningSnapshot>(emptyPlanning);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      void loadRecipeConflicts()
        .then((conflicts) => active && setRecipes(conflicts))
        .catch(() => undefined);
      void loadPlanningSnapshot()
        .then((snapshot) => active && setPlanning(snapshot))
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeToTopics(
      ['recipes', 'planning', 'sync'],
      refresh,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled]);
  return { recipes, planning };
}
