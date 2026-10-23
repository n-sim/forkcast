import { useRef, useState, type FormEvent } from 'react';
import type { FieldError } from './domain';
import {
  nutrients,
  validateNutritionGoals,
  type NutritionGoals,
} from './food-log';

export function NutritionGoalsForm({
  date,
  current,
  onSave,
  onCancel,
}: {
  /** The day being viewed; new goals apply from it unless changed. */
  date: string;
  /** The goals in effect on that day, offered as a starting point. */
  current: NutritionGoals | null;
  onSave: (goals: NutritionGoals) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<NutritionGoals>(() => ({
    effectiveFrom: date,
    targets: current
      ? { ...current.targets }
      : { calories: null, protein: null, fat: null, carbohydrates: null },
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  function fieldStatus(path: string) {
    return {
      id: `goal-${path}`,
      'aria-invalid': errors.some((error) => error.path === path),
      'aria-describedby': errors.some((error) => error.path === path)
        ? `goal-error-${path}`
        : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setErrors([]);
    try {
      const { goals, errors } = validateNutritionGoals(draft);
      // Number inputs expose incomplete text (such as "1e") as an empty value.
      for (const { key, label } of nutrients) {
        const input = event.currentTarget.elements.namedItem(`targets.${key}`);
        if (input instanceof HTMLInputElement && input.validity.badInput) {
          errors.push({
            path: `targets.${key}`,
            message: `Enter a valid number for the ${label} goal, or clear it to set no goal.`,
          });
        }
      }
      if (!goals || errors.length > 0) {
        // One message per field: a bad number replaces the blank-goal notice.
        setErrors(
          errors.filter(
            (error, index) =>
              errors.findIndex((other) => other.path === error.path) === index,
          ),
        );
        requestAnimationFrame(() => summary.current?.focus());
        return;
      }
      setSaving(true);
      await onSave(goals);
    } catch {
      setError(
        'Your goals could not be saved on this device. Keep this form open and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="nutrition-goals-form-heading">
      <h2 id="nutrition-goals-form-heading">Set nutrition goals</h2>
      <p className="section-note" id="nutrition-goals-help">
        Daily targets apply from the chosen date until you set new ones. Earlier
        days keep the goals that applied to them. Leave a target blank to set no
        goal for it.
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
            <strong>Check your goals</strong>
            <ul>
              {errors.map((error) => (
                <li key={error.path} id={`goal-error-${error.path}`}>
                  <button
                    type="button"
                    className="error-link"
                    onClick={() =>
                      document.getElementById(`goal-${error.path}`)?.focus()
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
            Goals apply from
            <input
              {...fieldStatus('effectiveFrom')}
              type="date"
              value={draft.effectiveFrom}
              onChange={(event) =>
                setDraft({ ...draft, effectiveFrom: event.target.value })
              }
            />
          </label>
          <div className="metadata-fields">
            {nutrients.map(({ key, label, unit }) => (
              <label key={key}>
                Daily {label.toLowerCase()} goal ({unit})
                <input
                  {...fieldStatus(`targets.${key}`)}
                  name={`targets.${key}`}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="No goal"
                  aria-describedby={
                    fieldStatus(`targets.${key}`)['aria-describedby'] ??
                    'nutrition-goals-help'
                  }
                  value={draft.targets[key] ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      targets: {
                        ...draft.targets,
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
              {saving ? 'Saving…' : 'Save goals'}
            </button>
            <button
              className="button secondary"
              type="button"
              aria-keyshortcuts="Escape"
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
