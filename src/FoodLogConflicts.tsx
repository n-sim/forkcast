import { useState } from 'react';
import {
  formatDay,
  nutrients,
  type FoodLogConflict,
  type ManualFoodLogEntry,
  type NutritionGoals,
  type RecipeFoodLogEntry,
} from './food-log';
import { nutritionValue } from './nutrition';

type FoodLogRecord = NonNullable<FoodLogConflict['current']>;

function eatenAt(consumedAt: string): string {
  return `${formatDay(consumedAt.slice(0, 10))}, ${consumedAt.slice(11)}`;
}

/** What one side of a conflict holds, in words. */
function describe(
  kind: FoodLogConflict['kind'],
  record: FoodLogRecord | null,
): string {
  if (record === null) return 'Removed';
  if (kind === 'goals') {
    const { targets } = record as NutritionGoals;
    return nutrients
      .filter(({ key }) => targets[key] !== null)
      .map(
        ({ key, label, unit }) =>
          `${label} ${nutritionValue(targets[key], unit)}`,
      )
      .join(' · ');
  }
  if (kind === 'recipeEntry') {
    const entry = record as RecipeFoodLogEntry;
    return `${entry.portions} ${entry.portions === 1 ? 'portion' : 'portions'} · ${eatenAt(entry.consumedAt)}`;
  }
  const entry = record as ManualFoodLogEntry;
  return `${entry.description} · ${nutritionValue(entry.nutrition.calories, 'kcal')} · ${eatenAt(entry.consumedAt)}`;
}

/** What the record is, whichever side still has it. */
function title(conflict: FoodLogConflict): string {
  if (conflict.kind === 'goals')
    return `Nutrition goals from ${formatDay(conflict.key)}`;
  const entry = (conflict.current ?? conflict.alternative)!;
  return 'recipeName' in entry
    ? (entry as RecipeFoodLogEntry).recipeName
    : (entry as ManualFoodLogEntry).description;
}

/**
 * Food-log records changed on two of the person's devices at once: neither
 * change silently wins, so the person keeps one of them.
 */
export function FoodLogConflicts({
  conflicts,
  onResolve,
}: {
  conflicts: FoodLogConflict[];
  onResolve: (
    conflict: FoodLogConflict,
    keep: 'current' | 'alternative',
  ) => Promise<void>;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (conflicts.length === 0) return null;

  async function resolve(
    conflict: FoodLogConflict,
    keep: 'current' | 'alternative',
  ) {
    setSaving(conflict.id);
    setError('');
    try {
      await onResolve(conflict, keep);
    } catch {
      setError(
        'This change could not be decided. Both versions are kept. Try again.',
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <section
      className="panel food-log-conflicts"
      aria-labelledby="food-log-conflicts-heading"
    >
      <h2 id="food-log-conflicts-heading">Food log changed on two devices</h2>
      <p className="section-note">
        These were changed on two of your devices at the same time. Choose which
        version to keep.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <ol aria-label="Competing food-log changes">
        {conflicts.map((conflict) => {
          const name = title(conflict);
          return (
            <li key={conflict.id} aria-label={name}>
              <h3>{name}</h3>
              <ul>
                <li>Current: {describe(conflict.kind, conflict.current)}</li>
                <li>
                  Other device: {describe(conflict.kind, conflict.alternative)}
                </li>
              </ul>
              <div className="form-actions">
                <button
                  className="button secondary"
                  disabled={saving !== null}
                  aria-busy={saving === conflict.id}
                  onClick={() => void resolve(conflict, 'current')}
                >
                  Keep current
                </button>
                <button
                  className="button primary"
                  disabled={saving !== null}
                  aria-busy={saving === conflict.id}
                  onClick={() => void resolve(conflict, 'alternative')}
                >
                  Use other device’s change
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
