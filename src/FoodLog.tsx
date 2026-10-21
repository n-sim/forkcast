import { useEffect, useRef, useState } from 'react';
import {
  localDateTime,
  nutrients,
  type DailyFoodLog,
  type ManualFoodLogEntry,
  type RecipeFoodLogEntry,
} from './food-log';
import {
  loadFoodLogDate,
  loadFoodLogDay,
  saveFoodLogDate,
  saveManualFoodLogEntry,
  saveRecipeFoodLogEntry,
  subscribeToFoodLogChanges,
} from './food-log-store';
import { ManualFoodLogForm } from './ManualFoodLogForm';
import { RecipeFoodLogForm } from './RecipeFoodLogForm';
import type { Recipe } from './domain';
import { nutritionValue } from './nutrition';

export function FoodLog({ recipes }: { recipes: Recipe[] }) {
  const [daily, setDaily] = useState<DailyFoodLog | null>(null);
  const [date, setDate] = useState('');
  const [adding, setAdding] = useState<'manual' | 'recipe' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [calculationError, setCalculationError] = useState('');

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
        const log = await loadFoodLogDay(chosen);
        if (active && request === requests.current) {
          setDate(chosen);
          setDaily(log);
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
            disabled={!daily || Boolean(adding) || recipes.length === 0}
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
            disabled={!daily || Boolean(adding)}
            onClick={() => {
              setAdding('manual');
              setMessage('');
            }}
          >
            + Add manual entry
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
      {adding === 'manual' && (
        <ManualFoodLogForm
          date={date}
          onSave={save}
          onCancel={() => setAdding(null)}
        />
      )}
      {daily && (
        <>
          <section className="panel" aria-labelledby="daily-nutrition-heading">
            <h2 id="daily-nutrition-heading">Daily nutrition</h2>
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
                    <li key={entry.id} className="panel">
                      <p className="eyebrow">
                        {entry.recipeId ? 'Recipe entry' : 'Manual entry'} ·{' '}
                        <time dateTime={entry.consumedAt}>
                          {entry.consumedAt.slice(11)}
                        </time>
                      </p>
                      <h3>
                        {recipe ? (
                          <a
                            href={`#/recipes/${recipe.id}?nutritionVersion=${encodeURIComponent(entry.nutritionVersionId!)}`}
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
                        <p className="nutrition-version-notice" id={noticeId}>
                          Newer recipe nutrition available. This entry keeps its
                          logged values.
                        </p>
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
