import { useState } from 'react';
import type { Recipe } from './domain';
import {
  resolvePlanningConflict,
  type PlanningConflict,
  type PlanningData,
} from './planning-store';

const fieldNames: Record<string, string> = {
  portions: 'Portions to cook',
  cookingDate: 'Cooking date',
  cookingTime: 'Cooking time',
  recipeId: 'Recipe',
  quantity: 'Quantity',
  name: 'Item name',
  unit: 'Unit',
  checked: 'Shopping progress',
  requirements: 'Generated shopping requirements',
};

function Contents({ value, recipes }: { value: unknown; recipes: Recipe[] }) {
  if (value === null) return <p>Removed</p>;
  if (typeof value === 'boolean')
    return <p>{value ? 'Checked off' : 'Still to buy'}</p>;
  if (typeof value !== 'object') {
    const recipe = recipes.find((recipe) => recipe.id === value);
    return <p>{recipe?.name ?? String(value)}</p>;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.recipeId === 'string')
    return (
      <>
        <p>
          {recipes.find((recipe) => recipe.id === record.recipeId)?.name ??
            'Recipe unavailable'}
        </p>
        <p>
          {String(record.cookingDate)} · {String(record.portions)} portions
          {record.cookingTime ? ` · ${String(record.cookingTime)}` : ''}
        </p>
      </>
    );
  if (typeof record.quantity === 'number')
    return (
      <p>
        {String(record.name)} · {record.quantity} {String(record.unit)}
        {record.checked ? ' · Checked off' : ''}
      </p>
    );
  const requirements =
    (record.requirements as Record<string, unknown> | undefined) ?? record;
  const items = requirements.items;
  const manual = record.manualItems;
  const values = [
    ...(Array.isArray(items)
      ? items
      : items && typeof items === 'object'
        ? Object.values(items)
        : []),
    ...(Array.isArray(manual)
      ? manual
      : manual && typeof manual === 'object'
        ? Object.values(manual)
        : []),
  ];
  return (
    <>
      {requirements.startDate && (
        <p>
          {String(requirements.startDate)} through{' '}
          {String(requirements.endDate)}
        </p>
      )}
      {values.length ? (
        values.map((item, index) => (
          <Contents key={index} value={item} recipes={recipes} />
        ))
      ) : (
        <p>No shopping items.</p>
      )}
    </>
  );
}

function recordName(
  conflict: PlanningConflict,
  data: PlanningData,
  recipes: Recipe[],
) {
  if (conflict.path[0] === 'cookings') {
    const cooking = data.cookings[conflict.path[1]!];
    return (
      recipes.find((recipe) => recipe.id === cooking?.recipeId)?.name ??
      'Planned cooking'
    );
  }
  const id = conflict.path.find((_, index) =>
    ['items', 'manualItems'].includes(conflict.path[index - 1] ?? ''),
  );
  return (
    [
      ...(data.shoppingList?.items ?? []),
      ...(data.shoppingList?.manualItems ?? []),
    ].find((item) => item.id === id)?.name ?? 'Shopping list'
  );
}

export function PlanningConflicts({
  conflicts,
  data,
  recipes,
  canResolve,
  onRefresh,
}: {
  conflicts: PlanningConflict[];
  data: PlanningData;
  recipes: Recipe[];
  canResolve: boolean;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(conflict: PlanningConflict, value: unknown) {
    if (!canResolve) return;
    setBusy(true);
    setError('');
    try {
      await resolvePlanningConflict(conflict, value);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <article>
      <h1>Review planning conflicts</h1>
      <p>
        Choose the value your household wants to keep for each competing change.
      </p>
      {!canResolve && (
        <p>Sign in to your household to resolve competing changes.</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!conflicts.length && <p>No unresolved planning conflicts.</p>}
      {conflicts.map((conflict) => (
        <section
          key={JSON.stringify(conflict.path)}
          aria-label="Competing planning changes"
        >
          <h2>
            {recordName(conflict, data, recipes)} ·{' '}
            {fieldNames[conflict.path.at(-1)!] ?? 'Competing changes'}
          </h2>
          <div className="conflict-alternatives">
            {conflict.values.map((value, index) => (
              <section
                className="panel"
                aria-label={`Alternative ${index + 1}`}
                key={index}
              >
                <h3>Alternative {index + 1}</h3>
                <Contents value={value} recipes={recipes} />
                <button
                  className="button primary"
                  disabled={busy || !canResolve}
                  onClick={() => void choose(conflict, value)}
                >
                  Use this value
                </button>
              </section>
            ))}
          </div>
        </section>
      ))}
      <a href="#/meal-plan">Back to meal plan</a>
    </article>
  );
}
