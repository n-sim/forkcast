import { useRef, useState, type FormEvent } from 'react';
import type { FieldError, Recipe } from './domain';
import {
  cookingPeriodLabels,
  cookingPeriodOf,
  cookingPeriods,
  validatePlannedCooking,
  type PlannedCooking,
  type PlannedCookingDraft,
} from './planning';

export function PlannedCookingForm({
  recipes,
  date,
  cooking,
  onSave,
  onCancel,
}: {
  recipes: Recipe[];
  date: string;
  cooking?: PlannedCooking;
  onSave: (cooking: PlannedCooking) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PlannedCookingDraft>(() =>
    cooking
      ? { ...cooking, cookingTime: cookingPeriodOf(cooking.cookingTime) }
      : {
          id: crypto.randomUUID(),
          recipeId: '',
          cookingDate: date,
          portions: null,
          cookingTime: null,
        },
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  function fieldStatus(path: string) {
    return {
      id: `plan-${path}`,
      'aria-invalid': errors.some((error) => error.path === path),
      'aria-describedby': errors.some((error) => error.path === path)
        ? `plan-error-${path}`
        : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const { cooking, errors } = validatePlannedCooking(draft);
    if (
      !recipes.some((recipe) => recipe.id === draft.recipeId) &&
      !errors.some((error) => error.path === 'recipeId')
    ) {
      errors.push({
        path: 'recipeId',
        message: 'Choose a recipe from your collection.',
      });
    }
    setErrors(errors);
    if (!cooking || errors.length) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setSaving(true);
    try {
      await onSave(cooking);
    } catch (error) {
      setError(
        `Your planned cooking could not be saved. Keep this form open and try again. ${String(error)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="planned-cooking-heading">
      <h2 id="planned-cooking-heading">Planned cooking details</h2>
      <p className="section-note" id="planning-portions-help">
        Choose the total portions to cook, including food for other household
        members.
      </p>
      <form noValidate onSubmit={submit}>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {errors.length > 0 && (
          <div
            className="error-banner"
            role="alert"
            tabIndex={-1}
            ref={summary}
          >
            <strong>Check your planned cooking</strong>
            <ul>
              {errors.map((error) => (
                <li key={error.path} id={`plan-error-${error.path}`}>
                  <button
                    className="error-link"
                    type="button"
                    onClick={() =>
                      document.getElementById(`plan-${error.path}`)?.focus()
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
            Recipe
            <select
              {...fieldStatus('recipeId')}
              aria-label="Recipe"
              autoFocus
              value={draft.recipeId}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  recipeId: event.target.value,
                  portions:
                    recipes.find((recipe) => recipe.id === event.target.value)
                      ?.basePortions ?? null,
                })
              }
            >
              <option value="">Choose a recipe</option>
              {[...recipes]
                .sort((a, b) => a.name.localeCompare(b.name, 'en'))
                .map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="metadata-fields">
            <label>
              Cooking date
              <input
                {...fieldStatus('cookingDate')}
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={draft.cookingDate}
                onChange={(event) =>
                  setDraft({ ...draft, cookingDate: event.target.value })
                }
              />
            </label>
            <label>
              Portions to cook
              <input
                {...fieldStatus('portions')}
                aria-describedby={
                  fieldStatus('portions')['aria-describedby'] ??
                  'planning-portions-help'
                }
                type="number"
                step="any"
                value={draft.portions ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    portions:
                      event.target.value === ''
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Cooking time (optional)
              <select
                {...fieldStatus('cookingTime')}
                value={draft.cookingTime ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    cookingTime: event.target.value || null,
                  })
                }
              >
                <option value="">Not specified</option>
                {cookingPeriods.map((period) => (
                  <option key={period} value={period}>
                    {cookingPeriodLabels[period]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button className="button primary" type="submit">
              {saving ? 'Saving…' : 'Save planned cooking'}
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
