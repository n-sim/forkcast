import { validatePlannedCooking, type PlannedCooking } from './planning';
import {
  changePlanningData,
  loadPlanningData,
  planningEditBase,
  type PlanningEditBase,
} from './planning-sync-store';

export type EditablePlannedCooking = PlannedCooking & {
  editBase?: PlanningEditBase;
};

export async function loadPlannedCookings(): Promise<EditablePlannedCooking[]> {
  const { state, data } = await loadPlanningData();
  const editBase = planningEditBase(state, data);
  return Object.values(data.cookings).map((cooking) => ({
    ...cooking,
    editBase,
  }));
}

export async function savePlannedCooking(
  draft: PlannedCooking,
  editBase?: PlanningEditBase,
): Promise<void> {
  const { cooking } = validatePlannedCooking(draft);
  if (!cooking) throw new Error('Check the planned cooking before saving.');
  await changePlanningData((data, recipes) => {
    if (!recipes.some((recipe) => recipe.id === cooking.recipeId))
      throw new Error('Choose a current recipe for your household meal plan.');
    data.cookings[cooking.id] = cooking;
  }, editBase);
}

export async function removePlannedCooking(
  id: string,
  editBase?: PlanningEditBase,
): Promise<void> {
  await changePlanningData((data) => {
    delete data.cookings[id];
  }, editBase);
}

export function subscribeToPlanningChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-planning');
  channel.onmessage = listener;
  return () => channel.close();
}
