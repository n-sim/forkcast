import { useEffect, useState } from 'react';
import {
  dailyManualFoodLog,
  localDateTime,
  nutrients,
  type ManualFoodLogEntry,
} from './food-log';
import {
  loadFoodLog,
  saveFoodLogDate,
  saveManualFoodLogEntry,
  subscribeToFoodLogChanges,
} from './food-log-store';
import { ManualFoodLogForm } from './ManualFoodLogForm';

const numberFormat = new Intl.NumberFormat('en', {
  maximumSignificantDigits: 12,
});

function nutritionValue(value: number | null, unit: string) {
  return value === null ? 'Unknown' : `${numberFormat.format(value)} ${unit}`;
}

export function FoodLog() {
  const [entries, setEntries] = useState<ManualFoodLogEntry[]>([]);
  const [date, setDate] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function refresh(initial = false) {
      try {
        const log = await loadFoodLog();
        if (active) {
          setEntries(log.entries);
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
      dailyManualFoodLog([], date);
      await saveFoodLogDate(date);
      setDate(date);
      setMessage('');
      setError('');
    } catch {
      setError('This food log date could not be saved. Try again.');
    }
  }

  async function save(entry: ManualFoodLogEntry) {
    await saveManualFoodLogEntry(entry);
    setEntries((current) => [
      ...current.filter((item) => item.id !== entry.id),
      entry,
    ]);
    setDate(entry.consumedAt.slice(0, 10));
    setAdding(false);
    setMessage('Food-log entry saved on this device.');
    setError('');
  }

  let daily = null;
  let calculationError = '';
  if (date) {
    try {
      daily = dailyManualFoodLog(entries, date);
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
        <button
          className="button primary"
          aria-label="Add manual entry"
          disabled={!daily || adding}
          onClick={() => {
            setAdding(true);
            setMessage('');
          }}
        >
          + Add manual entry
        </button>
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
              disabled={adding}
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
      {adding && (
        <ManualFoodLogForm
          date={date}
          onSave={save}
          onCancel={() => setAdding(false)}
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
                      Manual entry ·{' '}
                      <time dateTime={entry.consumedAt}>
                        {entry.consumedAt.slice(11)}
                      </time>
                    </p>
                    <h3>{entry.description}</h3>
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
