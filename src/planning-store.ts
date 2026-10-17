import { validatePlannedCooking, type PlannedCooking } from './planning';
import type { ShoppingList } from './shopping';
import { execute, subscribeToTopics } from './core';

export interface PlanningData {
  cookings: Record<string, PlannedCooking>;
  shoppingList: ShoppingList | null;
}

export interface PlanningConflict {
  path: string[];
  values: unknown[];
}

export interface PlanningSnapshot {
  revision: string | null;
  data: PlanningData;
  conflicts: PlanningConflict[];
}

/** What a view of the plan was based on; saving from it never overwrites newer changes. */
export interface PlanningEditBase {
  baseRevision: string | null;
  baseMutationId: string | null;
  data: PlanningData;
}

export type EditablePlannedCooking = PlannedCooking & {
  editBase?: PlanningEditBase;
};

export async function loadPlannedCookings(): Promise<EditablePlannedCooking[]> {
  const plan = await execute<{
    cookings: PlannedCooking[];
    editBase: PlanningEditBase | null;
  }>('mealPlan');
  return plan.cookings.map((cooking) => ({
    ...cooking,
    editBase: plan.editBase ?? undefined,
  }));
}

export async function savePlannedCooking(
  draft: PlannedCooking,
  editBase?: PlanningEditBase,
): Promise<void> {
  const { cooking } = validatePlannedCooking(draft);
  if (!cooking) throw new Error('Check the planned cooking before saving.');
  await execute('planCooking', { cooking, editBase: editBase ?? null });
}

export async function removePlannedCooking(
  id: string,
  editBase?: PlanningEditBase,
): Promise<void> {
  await execute('removePlannedCooking', { id, editBase: editBase ?? null });
}

export function subscribeToPlanningChanges(listener: () => void): () => void {
  return subscribeToTopics(['planning', 'recipes'], listener);
}

export async function loadPlanningSnapshot(): Promise<PlanningSnapshot> {
  return execute<PlanningSnapshot>('planningSnapshot');
}

export async function resolvePlanningConflict(
  conflict: PlanningConflict,
  value: unknown,
): Promise<void> {
  await execute('resolvePlanningConflict', { conflict, value });
}
