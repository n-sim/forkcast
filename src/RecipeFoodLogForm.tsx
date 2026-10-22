import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FieldError, Recipe } from './domain';
import {
  formatDay,
  localDateTime,
  validateRecipeFoodLogEntry,
  type RecipeFoodLogEntry,
} from './food-log';
import { recipeNutrition } from './nutrition';
import { NutritionBrief } from './NutritionBrief';
import {
  loadCookingHistory,
  subscribeToCookingHistoryChanges,
  type RecipeHistory,
} from './recipe-store';

/** How many recently cooked recipes are offered as quick suggestions. */
const suggestionLimit = 5;

/** The recipes cooked most recently, newest first. */
function recentlyCooked(
  recipes: Recipe[],
  history: Record<string, RecipeHistory>,
): { recipe: Recipe; lastCookedAt: number }[] {
  return recipes
    .flatMap((recipe) => {
      const cooked = history[recipe.id];
      return cooked ? [{ recipe, lastCookedAt: cooked.lastCookedAt }] : [];
    })
    .sort((a, b) => b.lastCookedAt - a.lastCookedAt)
    .slice(0, suggestionLimit);
}

export function RecipeFoodLogForm({
  date,
  recipes,
  onSave,
  onCancel,
}: {
  date: string;
  recipes: Recipe[];
  onSave: (entry: RecipeFoodLogEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [recipeId, setRecipeId] = useState('');
  const [consumedAt, setConsumedAt] = useState(
    () => date + localDateTime().slice(10),
  );
  const [portions, setPortions] = useState<number | null>(1);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<Record<string, RecipeHistory>>({});
  useEffect(() => {
    // Suggestions are a convenience: without them the recipe list still works.
    const load = () => void loadCookingHistory().then(setHistory, () => {});
    load();
    return subscribeToCookingHistoryChanges(load);
  }, []);
  const suggestions = recentlyCooked(recipes, history);
  const recipe = recipes.find((recipe) => recipe.id === recipeId);
  const perPortion = recipe ? recipeNutrition(recipe) : null;

  function fieldStatus(path: string) {
    const invalid = errors.some((error) => error.path === path);
    return {
      id: `recipe-food-${path}`,
      'aria-invalid': invalid,
      'aria-describedby': invalid ? `recipe-food-error-${path}` : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      const { entry, errors } = validateRecipeFoodLogEntry({
        id,
        recipeId,
        recipeName: recipe?.name ?? '',
        nutritionVersionId: recipe?.nutritionVersionId ?? '',
        consumedAt,
        portions,
      });
      if (!entry) {
        setErrors(errors);
        requestAnimationFrame(() => summary.current?.focus());
        return;
      }
      setErrors([]);
      setSaving(true);
      await onSave(entry);
    } catch (error) {
      setError(
        `Your entry could not be saved. Keep this form open and try again. ${String(error)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="recipe-entry-heading">
      <h2 id="recipe-entry-heading">Recipe-linked food-log entry</h2>
      <p className="section-note">
        Record the portions you actually ate. Nutrition is retained from this
        recipe, including any unknown values.
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
                <li key={error.path} id={`recipe-food-error-${error.path}`}>
                  <button
                    type="button"
                    className="error-link"
                    onClick={() =>
                      document
                        .getElementById(`recipe-food-${error.path}`)
                        ?.focus()
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
          {suggestions.length > 0 && (
            <div
              role="group"
              aria-label="Recently cooked"
              className="recent-recipes"
            >
              <p className="section-note">
                Recently cooked. Choosing one only picks the recipe; you still
                enter what you ate.
              </p>
              {suggestions.map(({ recipe, lastCookedAt }) => (
                <button
                  key={recipe.id}
                  type="button"
                  className="button secondary"
                  aria-pressed={recipe.id === recipeId}
                  onClick={() => setRecipeId(recipe.id)}
                >
                  {recipe.name}
                  <small>
                    {' '}
                    · cooked{' '}
                    {formatDay(
                      localDateTime(new Date(lastCookedAt)).slice(0, 10),
                    )}
                  </small>
                </button>
              ))}
            </div>
          )}
          <label className="name-field">
            Recipe
            <select
              {...fieldStatus('recipeId')}
              aria-label="Recipe"
              value={recipeId}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              <option value="">Choose a recipe</option>
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name}
                </option>
              ))}
            </select>
          </label>
          <label className="name-field">
            Consumed at
            <input
              {...fieldStatus('consumedAt')}
              type="datetime-local"
              step="60"
              value={consumedAt}
              onChange={(event) => setConsumedAt(event.target.value)}
            />
          </label>
          <label className="name-field">
            Portions eaten
            <input
              {...fieldStatus('portions')}
              type="number"
              step="any"
              min="0"
              value={portions ?? ''}
              onChange={(event) =>
                setPortions(
                  event.target.value === '' ? null : Number(event.target.value),
                )
              }
            />
          </label>
          {perPortion && <NutritionBrief perPortion={perPortion} />}
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
