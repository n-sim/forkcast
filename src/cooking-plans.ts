import { execute } from './core';
import type { PlannedCooking } from './planning';
import type { PlanningEditBase } from './planning-store';

// Manual scheduling and AI plan generation both run in the application core
// and return a proposal; nothing changes until it is applied.

export type SchedulingStrategy = 'lastCookedLongestAgo' | 'leastOftenCooked';

export const schedulingStrategyLabels: Record<SchedulingStrategy, string> = {
  lastCookedLongestAgo: 'Last cooked longest ago',
  leastOftenCooked: 'Least often cooked',
};

export interface CookingPlanProposal {
  /** The days applying the proposal replaces. */
  dates: string[];
  cookings: PlannedCooking[];
  /** Planned cookings on those days now; applying removes them. */
  replaced: PlannedCooking[];
  editBase: PlanningEditBase | null;
}

export const scheduleCookings = (request: {
  dates: string[];
  portions: number;
  minimumRating: number | null;
  strategy: SchedulingStrategy;
}) => execute<CookingPlanProposal>('scheduleCookings', request);

export const generateCookingPlan = (request: {
  model: string;
  request: string;
  startDate: string;
  endDate: string;
}) =>
  // A generation can legitimately take minutes.
  execute<CookingPlanProposal>('generateCookingPlan', request, 200_000);

/**
 * Replaces the proposal's days with its cookings. The core refuses (and
 * changes nothing) when a cooking on those days is not one of `replaced`,
 * so a plan changed elsewhere is never replaced unseen.
 */
export async function applyCookingPlan(
  proposal: CookingPlanProposal,
): Promise<void> {
  await execute('applyCookingPlan', {
    dates: proposal.dates,
    cookings: proposal.cookings,
    replacing: proposal.replaced.map((cooking) => cooking.id),
    editBase: proposal.editBase,
  });
}
