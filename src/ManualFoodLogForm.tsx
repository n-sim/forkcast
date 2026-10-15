import { useRef, useState, type FormEvent } from 'react';
import type { FieldError } from './domain';
import {
  localDateTime,
  nutrients,
  validateManualFoodLogEntry,
  type ManualFoodLogEntry,
} from './food-log';

export function ManualFoodLogForm({
  date,
  onSave,
  onCancel,
}: {
  date: string;
  onSave: (entry: ManualFoodLogEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ManualFoodLogEntry>(() => ({
    id: crypto.randomUUID(),
    description: '',
    consumedAt: date + localDateTime().slice(10),
    nutrition: {
      calories: null,
      protein: null,
      fat: null,
      carbohydrates: null,
    },
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  function fieldStatus(path: string) {
    return {
      id: `food-${path}`,
      'aria-invalid': errors.some((error) => error.path === path),
      'aria-describedby': errors.some((error) => error.path === path)
        ? `food-error-${path}`
        : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setErrors([]);
    try {
      const { entry, errors } = validateManualFoodLogEntry(draft);
      // Number inputs expose incomplete text (such as "1e") as an empty value.
      // Check the browser's input state before treating a blank as unknown.
      for (const { key, label } of nutrients) {
        const input = event.currentTarget.elements.namedItem(
          `nutrition.${key}`,
        );
        if (input instanceof HTMLInputElement && input.validity.badInput) {
          errors.push({
            path: `nutrition.${key}`,
            message: `Enter a valid number for ${label}, or clear it to leave it unknown.`,
          });
        }
      }
      if (!entry || errors.length > 0) {
        setErrors(errors);
        requestAnimationFrame(() => summary.current?.focus());
        return;
      }
      setSaving(true);
      await onSave(entry);
    } catch {
      setError(
        'Your entry could not be saved on this device. Keep this form open and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="manual-entry-heading">
      <h2 id="manual-entry-heading">Manual food-log entry</h2>
      <p className="section-note" id="manual-nutrition-help">
        Describe the food and amount you ate. Enter nutrition for that amount;
        leave any value blank if unknown. Zero means a known zero.
      </p>
      <form onSubmit={submit} noValidate>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {errors.length > 0 && (
          <div
            role="alert"
            className="error-banner"
            ref={summary}
            tabIndex={-1}
          >
            <strong>Check your entry</strong>
            <ul>
              {errors.map((error) => (
                <li key={error.path} id={`food-error-${error.path}`}>
                  <button
                    type="button"
                    className="error-link"
                    onClick={() =>
                      document.getElementById(`food-${error.path}`)?.focus()
                    }
                  >
                    {error.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset disabled={saving} className="food-entry-fields">
          <label className="name-field">
            Food description
            <input
              {...fieldStatus('description')}
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <label className="name-field">
            Consumed at
            <input
              {...fieldStatus('consumedAt')}
              type="datetime-local"
              step="60"
              value={draft.consumedAt}
              onChange={(event) =>
                setDraft({ ...draft, consumedAt: event.target.value })
              }
            />
          </label>
          <div className="metadata-fields">
            {nutrients.map(({ key, label, unit }) => (
              <label key={key}>
                {label} ({unit})
                <input
                  {...fieldStatus(`nutrition.${key}`)}
                  name={`nutrition.${key}`}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Unknown"
                  aria-describedby={
                    fieldStatus(`nutrition.${key}`)['aria-describedby'] ??
                    'manual-nutrition-help'
                  }
                  value={draft.nutrition[key] ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      nutrition: {
                        ...draft.nutrition,
                        [key]:
                          event.target.value === ''
                            ? null
                            : Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button className="button primary" type="submit">
              {saving ? 'Saving…' : 'Save entry'}
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
