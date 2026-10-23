import { useEffect, useRef, useState } from 'react';
import {
  formatDay,
  localDateTime,
  nutrients,
  type DailyFoodLog,
  type FoodLogConflict,
  type ManualFoodLogEntry,
  type NutritionGoals,
  type RecipeFoodLogEntry,
} from './food-log';
import {
  loadFoodLogDate,
  loadFoodLogDay,
  loadNutritionGoals,
  removeNutritionGoals,
  saveFoodLogDate,
  saveManualFoodLogEntry,
  saveNutritionGoals,
  saveRecipeFoodLogEntry,
  subscribeToFoodLogChanges,
  adoptCurrentFoodNutrition,
  editFoodLogEntry,
  loadFoodLogConflicts,
  removeFoodLogEntry,
  resolveFoodLogConflict,
} from './food-log-store';
import { FoodLogConflicts } from './FoodLogConflicts';
import {
  FoodLogEntryEditor,
  type FoodLogEntryChanges,
} from './FoodLogEntryEditor';
import { ManualFoodLogForm } from './ManualFoodLogForm';
import { NutritionGoalsForm } from './NutritionGoalsForm';
import { RecipeFoodLogForm } from './RecipeFoodLogForm';
import type { Recipe } from './domain';
import { nutritionValue } from './nutrition';

/** How the day's known intake compares with one nutrient's goal. */
function goalProgress(
  total: DailyFoodLog['totals'][keyof DailyFoodLog['totals']],
  unit: string,
): string {
  const goal = `Goal ${nutritionValue(total.target, unit)}`;
  // Unknown values could add to the day, so only state what is known.
  if (total.knownValue === null) return `${goal} · intake unknown`;
  if (total.unknownEntries > 0)
    return `${goal} · at least ${nutritionValue(total.knownValue, unit)} eaten`;
  const difference = total.target! - total.knownValue;
  if (Math.abs(difference) < 0.05) return `${goal} · goal reached`;
  return difference > 0
    ? `${goal} · ${nutritionValue(difference, unit)} remaining`
    : `${goal} · ${nutritionValue(-difference, unit)} over`;
}

export function FoodLog({
  recipes,
  aiAvailable = true,
}: {
  recipes: Recipe[];
  aiAvailable?: boolean;
}) {
  const [daily, setDaily] = useState<DailyFoodLog | null>(null);
  const [goalHistory, setGoalHistory] = useState<NutritionGoals[]>([]);
  const [conflicts, setConflicts] = useState<FoodLogConflict[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [adding, setAdding] = useState<'manual' | 'recipe' | 'goals' | null>(
    null,
  );
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [calculationError, setCalculationError] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);

  // The day being shown, set as soon as it is chosen so that a change
  // notification arriving meanwhile reloads the same day.
  const shown = useRef('');
  const requests = useRef(0);
  const refreshDay = useRef<(day?: string) => void>(() => undefined);

  useEffect(() => {
    let active = true;
    async function refresh(day?: string) {
      if (day) shown.current = day;
      const request = ++requests.current;
      try {
        const chosen =
          shown.current ||
          (await loadFoodLogDate()) ||
          localDateTime().slice(0, 10);
        shown.current = chosen;
        const [log, goals, open] = await Promise.all([
          loadFoodLogDay(chosen),
          loadNutritionGoals(),
          loadFoodLogConflicts(),
        ]);
        if (active && request === requests.current) {
          setDate(chosen);
          setDaily(log);
          setGoalHistory(goals);
          setConflicts(open);
          setCalculationError('');
          setError('');
        }
      } catch (failure) {
        if (active && request === requests.current) {
          setDaily(null);
          if (failure instanceof Error && failure.message.includes('retained'))
            setCalculationError(failure.message);
          else
            setError(
              'Your food log could not be loaded. Reload to try again. Your stored data has been kept.',
            );
        }
      }
    }
    refreshDay.current = (day) => void refresh(day);
    const unsubscribe = subscribeToFoodLogChanges(() => void refresh());
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function selectDate(date: string) {
    if (!date) return;
    // Show the chosen day at once; the day's entries follow when loaded, and
    // nothing can be added to the previous day's view in the meantime.
    setDate(date);
    setDaily(null);
    try {
      await saveFoodLogDate(date);
      refreshDay.current(date);
      setMessage('');
      setError('');
    } catch {
      setError('This food log date could not be saved. Try again.');
      refreshDay.current();
    }
  }

  async function save(entry: ManualFoodLogEntry | RecipeFoodLogEntry) {
    if ('recipeId' in entry) await saveRecipeFoodLogEntry(entry);
    else await saveManualFoodLogEntry(entry);
    refreshDay.current(entry.consumedAt.slice(0, 10));
    setAdding(null);
    setMessage('Food-log entry saved on this device.');
    setError('');
  }

  async function saveGoals(goals: NutritionGoals) {
    await saveNutritionGoals(goals);
    refreshDay.current();
    setAdding(null);
    setMessage(
      `Nutrition goals from ${formatDay(goals.effectiveFrom)} saved on this device.`,
    );
    setError('');
  }

  async function removeGoals(effectiveFrom: string) {
    try {
      await removeNutritionGoals(effectiveFrom);
      refreshDay.current();
      setMessage(`Nutrition goals from ${formatDay(effectiveFrom)} removed.`);
      setError('');
    } catch {
      setError('These nutrition goals could not be removed. Try again.');
    }
  }

  async function saveEntry(entryId: string, changes: FoodLogEntryChanges) {
    await editFoodLogEntry(entryId, changes);
    setEditing(null);
    refreshDay.current(changes.consumedAt.slice(0, 10));
    setMessage('Food-log entry changed on this device.');
    setError('');
  }

  async function removeEntry(entryId: string, description: string) {
    try {
      await removeFoodLogEntry(entryId);
      refreshDay.current();
      setMessage(`${description} removed from the food log.`);
      setError('');
    } catch {
      setError('This food-log entry could not be removed. Try again.');
    }
  }

  async function resolveConflict(
    conflict: FoodLogConflict,
    keep: 'current' | 'alternative',
  ) {
    await resolveFoodLogConflict(conflict.id, keep);
    refreshDay.current();
    setMessage(
      keep === 'current'
        ? 'Kept the current version.'
        : 'Kept the other device’s change.',
    );
  }

  async function adoptCurrentNutrition(entryId: string) {
    setUpdating(entryId);
    setMessage('');
    try {
      await adoptCurrentFoodNutrition(entryId);
      refreshDay.current();
      setMessage('This food-log entry now uses the current recipe nutrition.');
      setError('');
    } catch {
      setError(
        'This food-log entry could not be updated. It keeps its logged nutrition.',
      );
    } finally {
      setUpdating(null);
    }
  }

  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">What you ate, when you ate it</p>
          <h1>Food log</h1>
          <p>Your personal daily intake.</p>
        </div>
        <div className="food-log-actions">
          <button
            className="button primary"
            disabled={
              !daily ||
              Boolean(adding) ||
              editing !== null ||
              recipes.length === 0
            }
            aria-keyshortcuts="R"
            onClick={() => {
              setAdding('recipe');
              setMessage('');
            }}
          >
            Log recipe portions
          </button>
          <button
            className="button primary"
            aria-label="Add manual entry"
            aria-keyshortcuts="M"
            disabled={!daily || Boolean(adding) || editing !== null}
            onClick={() => {
              setAdding('manual');
              setMessage('');
            }}
          >
            + Add manual entry
          </button>
          <button
            className="button secondary"
            disabled={!daily || Boolean(adding) || editing !== null}
            onClick={() => {
              setAdding('goals');
              setMessage('');
            }}
          >
            Set nutrition goals
          </button>
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {calculationError && (
        <p className="error-banner" role="alert">
          {calculationError}
        </p>
      )}
      {!date && !error && <p role="status">Loading food log…</p>}
      {date && (
        <section className="panel quantity-controls" aria-label="Food log day">
          <label>
            Food log date
            <input
              type="date"
              value={date}
              disabled={Boolean(adding)}
              onChange={(event) => void selectDate(event.target.value)}
            />
          </label>
          <p className="section-note">
            Record the food you actually ate, independently of cooking and
            plans.
          </p>
        </section>
      )}
      <p role="status" aria-label="Food log status">
        {message}
      </p>
      {adding === 'recipe' && (
        <RecipeFoodLogForm
          date={date}
          recipes={recipes}
          onSave={save}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'goals' && daily && (
        <NutritionGoalsForm
          date={date}
          current={daily.goals}
          onSave={saveGoals}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'manual' && (
        <ManualFoodLogForm
          date={date}
          aiAvailable={aiAvailable}
          onSave={save}
          onCancel={() => setAdding(null)}
        />
      )}
      <FoodLogConflicts conflicts={conflicts} onResolve={resolveConflict} />
      {daily && (
        <>
          <section className="panel" aria-labelledby="daily-nutrition-heading">
            <h2 id="daily-nutrition-heading">Daily nutrition</h2>
            <p className="section-note">
              {daily.goals
                ? `Compared with your goals from ${formatDay(daily.goals.effectiveFrom)}.`
                : 'No nutrition goals apply to this day.'}
            </p>
            {daily.incomplete && (
              <p className="nutrition-incomplete">
                Incomplete nutrition totals: some entries have unknown values.
                Only known values are summed.
              </p>
            )}
            <dl className="recipe-metadata">
              {nutrients.map(({ key, label, unit }) => (
                <div key={key} role="group" aria-label={`${label} total`}>
                  <dt>{label}</dt>
                  <dd>{nutritionValue(daily.totals[key].knownValue, unit)}</dd>
                  {daily.totals[key].target !== null && (
                    <p className="goal-progress">
                      <progress
                        aria-label={`${label} goal progress`}
                        max={daily.totals[key].target!}
                        value={Math.min(
                          daily.totals[key].knownValue ?? 0,
                          daily.totals[key].target!,
                        )}
                      />
                      {goalProgress(daily.totals[key], unit)}
                    </p>
                  )}
                  {daily.totals[key].unknownEntries > 0 && (
                    <p className="nutrition-incomplete">
                      Incomplete · {daily.totals[key].unknownEntries}{' '}
                      {daily.totals[key].unknownEntries === 1
                        ? 'entry'
                        : 'entries'}{' '}
                      unknown
                    </p>
                  )}
                </div>
              ))}
            </dl>
          </section>
          <section className="panel" aria-labelledby="goal-history-heading">
            <h2 id="goal-history-heading">Nutrition goal history</h2>
            {goalHistory.length === 0 ? (
              <p>
                No nutrition goals set. Set goals to compare each day with your
                targets.
              </p>
            ) : (
              <ol className="goal-history" aria-label="Nutrition goal history">
                {goalHistory.map((goals) => (
                  <li key={goals.effectiveFrom}>
                    <h3>
                      From{' '}
                      <time dateTime={goals.effectiveFrom}>
                        {formatDay(goals.effectiveFrom)}
                      </time>
                    </h3>
                    <dl className="recipe-metadata">
                      {nutrients.map(({ key, label, unit }) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd>
                            {goals.targets[key] === null
                              ? 'No goal'
                              : nutritionValue(goals.targets[key], unit)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <button
                      className="button secondary"
                      disabled={Boolean(adding)}
                      aria-label={`Remove goals from ${formatDay(goals.effectiveFrom)}`}
                      onClick={() => void removeGoals(goals.effectiveFrom)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-labelledby="food-entries-heading">
            <h2 id="food-entries-heading">Food eaten</h2>
            {daily.entries.length === 0 ? (
              <p>No food logged for this day.</p>
            ) : (
              <ol className="food-log-entries" aria-label="Food-log entries">
                {daily.entries.map((entry) => {
                  const recipe = entry.recipeArchived
                    ? undefined
                    : recipes.find((recipe) => recipe.id === entry.recipeId);
                  const olderNutrition =
                    recipe &&
                    entry.nutritionVersionId !== recipe.nutritionVersionId;
                  const noticeId = `nutrition-notice-${entry.id}`;
                  return (
                    <li
                      key={entry.id}
                      className="panel"
                      aria-label={entry.description}
                    >
                      <p className="eyebrow">
                        {entry.recipeId ? 'Recipe entry' : 'Manual entry'} ·{' '}
                        <time dateTime={entry.consumedAt}>
                          {entry.consumedAt.slice(11)}
                        </time>
                      </p>
                      <h3>
                        {recipe ? (
                          <a
                            href={`#/recipes/${recipe.id}?nutritionVersion=${encodeURIComponent(entry.nutritionVersionId!)}&entry=${encodeURIComponent(entry.id)}`}
                            aria-describedby={
                              olderNutrition ? noticeId : undefined
                            }
                          >
                            {entry.description}
                          </a>
                        ) : (
                          entry.description
                        )}
                      </h3>
                      {entry.recipeArchived && (
                        <p className="section-note">
                          Archived recipe. This entry keeps its logged
                          nutrition.
                        </p>
                      )}
                      {olderNutrition && (
                        <div className="nutrition-version-notice">
                          <p id={noticeId}>
                            Newer recipe nutrition available. This entry keeps
                            its logged values.
                          </p>
                          <button
                            type="button"
                            className="button secondary"
                            aria-describedby={noticeId}
                            disabled={updating !== null}
                            aria-busy={updating === entry.id}
                            onClick={() => void adoptCurrentNutrition(entry.id)}
                          >
                            Use current nutrition
                          </button>
                        </div>
                      )}
                      {entry.portions !== null && (
                        <p>
                          {entry.portions}{' '}
                          {entry.portions === 1 ? 'portion' : 'portions'} eaten
                        </p>
                      )}
                      <dl className="recipe-metadata">
                        {nutrients.map(({ key, label, unit }) => (
                          <div key={key}>
                            <dt>{label}</dt>
                            <dd>
                              {nutritionValue(entry.nutrition[key], unit)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {editing === entry.id ? (
                        <FoodLogEntryEditor
                          entry={entry}
                          onSave={(changes) => saveEntry(entry.id, changes)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button secondary"
                            disabled={Boolean(adding) || editing !== null}
                            aria-label={`Edit ${entry.description}`}
                            onClick={() => {
                              setEditing(entry.id);
                              setMessage('');
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={Boolean(adding) || editing !== null}
                            aria-label={`Remove ${entry.description}`}
                            onClick={() =>
                              void removeEntry(entry.id, entry.description)
                            }
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </article>
  );
}
