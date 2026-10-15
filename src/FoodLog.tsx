import { useEffect, useState } from 'react';
import {
  dailyFoodLog,
  localDateTime,
  nutrients,
  type ManualFoodLogEntry,
  type RecipeFoodLogEntry,
  type FoodLogData,
} from './food-log';
import {
  loadFoodLog,
  saveFoodLogDate,
  saveManualFoodLogEntry,
  saveRecipeFoodLogEntry,
  subscribeToFoodLogChanges,
} from './food-log-store';
import { ManualFoodLogForm } from './ManualFoodLogForm';
import { RecipeFoodLogForm } from './RecipeFoodLogForm';
import type { Recipe } from './domain';
import { nutritionValue } from './nutrition';

const emptyLog: FoodLogData = {
  entries: [],
  recipeEntries: [],
  nutritionVersions: [],
};

export function FoodLog({ recipes }: { recipes: Recipe[] }) {
  const [log, setLog] = useState<FoodLogData>(emptyLog);
  const [date, setDate] = useState('');
  const [adding, setAdding] = useState<'manual' | 'recipe' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function refresh(initial = false) {
      try {
        const log = await loadFoodLog();
        if (active) {
          setLog(log);
          if (initial) setDate(log.date ?? localDateTime().slice(0, 10));
          setError('');
        }
      } catch {
        if (active)
          setError(
            'Your food log could not be loaded. Reload to try again. Your stored data has been kept.',
          );
      }
    }
    const unsubscribe = subscribeToFoodLogChanges(() => void refresh());
    void refresh(true);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function selectDate(date: string) {
    if (!date) return;
    try {
      dailyFoodLog(emptyLog, date);
      await saveFoodLogDate(date);
      setDate(date);
      setMessage('');
      setError('');
    } catch {
      setError('This food log date could not be saved. Try again.');
    }
  }

  async function save(entry: ManualFoodLogEntry | RecipeFoodLogEntry) {
    if ('recipeId' in entry) await saveRecipeFoodLogEntry(entry);
    else await saveManualFoodLogEntry(entry);
    setLog(await loadFoodLog());
    setDate(entry.consumedAt.slice(0, 10));
    setAdding(null);
    setMessage('Food-log entry saved on this device.');
    setError('');
  }

  let daily = null;
  let calculationError = '';
  if (date) {
    try {
      daily = dailyFoodLog(log, date);
    } catch (error) {
      calculationError = String(error);
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
                {daily.entries.map((entry) => (
                  <li key={entry.id} className="panel">
                    <p className="eyebrow">
                      {entry.recipeId ? 'Recipe entry' : 'Manual entry'} ·{' '}
                      <time dateTime={entry.consumedAt}>
                        {entry.consumedAt.slice(11)}
                      </time>
                    </p>
                    <h3>{entry.description}</h3>
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
                          <dd>{nutritionValue(entry.nutrition[key], unit)}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </article>
  );
}
