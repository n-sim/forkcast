import { useRef, useState, type FormEvent } from 'react';
import {
  difficultyLabels,
  validateRecipe,
  calculateRecipe,
  unitLabels,
  type Difficulty,
  type FieldError,
  type Recipe,
  type RecipeDraft,
  type Unit,
} from './domain';
import { StepAllocations } from './StepAllocations';
import { AllocationChecks } from './AllocationChecks';
import { nutrients } from './food-log';
import { unknownNutrition } from './nutrition';
import { RecipeEstimation, ingredientSignature } from './RecipeEstimation';

function emptyIngredient() {
  return {
    id: crypto.randomUUID(),
    name: '',
    quantity: null,
    unit: 'g' as const,
  };
}

function emptyStep() {
  return { id: crypto.randomUUID(), instruction: '', allocations: [] };
}

function numberValue(value: string): number | null {
  return value === '' ? null : Number(value);
}

export function RecipeForm({
  recipe: initialRecipe,
  onSave,
  onCancel,
  aiAvailable = true,
}: {
  recipe?: Recipe;
  onSave: (recipe: Recipe) => Promise<void>;
  onCancel: () => void;
  aiAvailable?: boolean;
}) {
  const [draft, setDraft] = useState<RecipeDraft>(
    () =>
      initialRecipe ?? {
        id: crypto.randomUUID(),
        name: '',
        label: null,
        basePortions: 2,
        ingredients: [emptyIngredient()],
        steps: [emptyStep()],
        difficulty: null,
        activeMinutes: null,
        totalMinutes: null,
      },
  );
  const baseline = useRef(ingredientSignature(draft)).current;
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const errorSummary = useRef<HTMLDivElement>(null);
  const originalRevisionId = useRef(initialRecipe?.syncRevisionId).current;
  const [saving, setSaving] = useState(false);
  const { recipe: validDraft } = validateRecipe(draft);
  let checks = null;
  if (validDraft) {
    try {
      checks = calculateRecipe(validDraft, validDraft.basePortions).checks;
    } catch {
      /* Out-of-range quantities are reported when viewed. */
    }
  }

  function fieldStatus(path: string) {
    const invalid = errors.some((error) => error.path === path);
    return {
      id: `field-${path}`,
      'aria-invalid': invalid,
      'aria-describedby': invalid ? `error-${path}` : undefined,
    };
  }

  function moveStep(index: number, direction: -1 | 1) {
    const steps = [...draft.steps];
    const step = steps[index];
    const other = steps[index + direction];
    if (!step || !other) return;
    steps[index] = other;
    steps[index + direction] = step;
    setDraft({ ...draft, steps });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setErrors([]);
    try {
      const { recipe, errors } = validateRecipe(draft);
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
      if (!recipe || errors.length > 0) {
        setErrors(errors);
        requestAnimationFrame(() => errorSummary.current?.focus());
        return;
      }
      setSaving(true);
      await onSave({ ...recipe, syncRevisionId: originalRevisionId });
    } catch {
      setError(
        'Your recipe could not be saved on this device. Keep this page open and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Make it your own</p>
          <h1>{initialRecipe ? 'Edit recipe' : 'New recipe'}</h1>
        </div>
        <p>A keeper starts here. Write it down, cook it again.</p>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {errors.length > 0 && (
        <div
          role="alert"
          className="error-banner"
          ref={errorSummary}
          tabIndex={-1}
        >
          <strong>A few things need your attention</strong>
          <ul>
            {errors.map((error) => (
              <li key={error.path} id={`error-${error.path}`}>
                <button
                  type="button"
                  className="error-link"
                  onClick={() =>
                    document.getElementById(`field-${error.path}`)?.focus()
                  }
                >
                  {error.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <section className="panel" aria-labelledby="basics-heading">
        <div className="section-heading">
          <span className="section-number">01</span>
          <h2 id="basics-heading">The basics</h2>
        </div>
        <label className="name-field">
          Recipe name
          <input
            {...fieldStatus('name')}
            autoFocus
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
            placeholder="What are we cooking?"
          />
        </label>
        <label className="name-field">
          Label (optional)
          <input
            {...fieldStatus('label')}
            value={draft.label ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, label: event.target.value || null })
            }
          />
        </label>
        <div className="metadata-fields">
          <label>
            Base portions
            <input
              {...fieldStatus('basePortions')}
              type="number"
              step="any"
              value={draft.basePortions ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  basePortions: numberValue(event.target.value),
                })
              }
            />
          </label>
          <label>
            Difficulty
            <select
              value={draft.difficulty ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  difficulty: (event.target.value as Difficulty) || null,
                })
              }
            >
              <option value="">Not specified</option>
              {Object.entries(difficultyLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Active time (minutes)
            <input
              {...fieldStatus('activeMinutes')}
              type="number"
              step="any"
              value={draft.activeMinutes ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  activeMinutes: numberValue(event.target.value),
                })
              }
            />
            <small>Dedicated work or attention.</small>
          </label>
          <label>
            Total time (minutes)
            <input
              {...fieldStatus('totalMinutes')}
              type="number"
              step="any"
              value={draft.totalMinutes ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  totalMinutes: numberValue(event.target.value),
                })
              }
            />
            <small>Elapsed time until ready to eat.</small>
          </label>
        </div>
      </section>
      <section
        className="panel"
        aria-labelledby="ingredients-heading"
        id="field-ingredients"
        tabIndex={-1}
      >
        <div className="section-heading">
          <span className="section-number">02</span>
          <h2 id="ingredients-heading">Ingredients</h2>
        </div>
        <p className="section-note">
          Total quantities for the recipe’s base portions.
        </p>
        <div className="ingredient-rows">
          {draft.ingredients.map((ingredient, index) => (
            <fieldset className="ingredient-row" key={ingredient.id}>
              <legend className="sr-only">Ingredient {index + 1}</legend>
              <label>
                Ingredient <span className="sr-only">{index + 1} name</span>
                <input
                  {...fieldStatus(`ingredients.${index}.name`)}
                  value={ingredient.name}
                  placeholder="e.g. Red lentils"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ingredients: draft.ingredients.map((item) =>
                        item.id === ingredient.id
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Quantity{' '}
                <span className="sr-only">for ingredient {index + 1}</span>
                <input
                  {...fieldStatus(`ingredients.${index}.quantity`)}
                  aria-label={`Ingredient ${index + 1} quantity`}
                  type="number"
                  step="any"
                  value={ingredient.quantity ?? ''}
                  placeholder="200"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ingredients: draft.ingredients.map((item) =>
                        item.id === ingredient.id
                          ? {
                              ...item,
                              quantity: numberValue(event.target.value),
                            }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Unit <span className="sr-only">for ingredient {index + 1}</span>
                <select
                  aria-label={`Ingredient ${index + 1} unit`}
                  value={ingredient.unit}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      ingredients: draft.ingredients.map((item) =>
                        item.id === ingredient.id
                          ? { ...item, unit: event.target.value as Unit }
                          : item,
                      ),
                    })
                  }
                >
                  {Object.entries(unitLabels).map(([unit, label]) => (
                    <option key={unit} value={unit}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="remove-button"
                type="button"
                aria-label={`Remove ingredient ${index + 1}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    ingredients: draft.ingredients.filter(
                      (item) => item.id !== ingredient.id,
                    ),
                    steps: draft.steps.map((step) => ({
                      ...step,
                      allocations: step.allocations.filter(
                        (allocation) =>
                          allocation.ingredientId !== ingredient.id,
                      ),
                    })),
                  })
                }
              >
                ×
              </button>
            </fieldset>
          ))}
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() =>
            setDraft({
              ...draft,
              ingredients: [...draft.ingredients, emptyIngredient()],
            })
          }
        >
          + Add ingredient
        </button>
      </section>
      <section
        className="panel"
        aria-labelledby="steps-heading"
        id="field-steps"
        tabIndex={-1}
      >
        <div className="section-heading">
          <span className="section-number">03</span>
          <h2 id="steps-heading">Cooking steps</h2>
        </div>
        <p className="section-note">
          Allocate amounts from the ingredient totals. Instructions do not
          change those totals. Removing an ingredient also removes its
          allocations.
        </p>
        {draft.steps.map((step, index) => (
          <div className="step-row" key={step.id}>
            <span className="step-number" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="step-editor">
              <label>
                Step {index + 1} instruction
                <textarea
                  {...fieldStatus(`steps.${index}.instruction`)}
                  rows={3}
                  value={step.instruction}
                  placeholder="Describe this cooking step…"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.map((item) =>
                        item.id === step.id
                          ? { ...item, instruction: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <StepAllocations
                step={step}
                index={index}
                ingredients={draft.ingredients}
                fieldStatus={fieldStatus}
                onChange={(allocations) =>
                  setDraft({
                    ...draft,
                    steps: draft.steps.map((item) =>
                      item.id === step.id ? { ...item, allocations } : item,
                    ),
                  })
                }
              />
              <div className="step-actions">
                <button
                  type="button"
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => moveStep(index, -1)}
                >
                  ↑ Move up
                </button>
                <button
                  type="button"
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === draft.steps.length - 1}
                  onClick={() => moveStep(index, 1)}
                >
                  ↓ Move down
                </button>
                <button
                  type="button"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.filter((item) => item.id !== step.id),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
        <button
          className="button secondary"
          type="button"
          onClick={() =>
            setDraft({ ...draft, steps: [...draft.steps, emptyStep()] })
          }
        >
          + Add step
        </button>
        {checks && <AllocationChecks recipe={draft} checks={checks} />}
      </section>
      <section className="panel" aria-labelledby="recipe-nutrition-heading">
        <div className="section-heading">
          <span className="section-number">04</span>
          <h2 id="recipe-nutrition-heading">Recipe nutrition</h2>
        </div>
        <p className="section-note" id="recipe-nutrition-help">
          Enter totals for the recipe’s base yield. Leave each unknown value
          blank; zero means a known zero. Ingredient edits keep these values.
        </p>
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
                aria-describedby={
                  fieldStatus(`nutrition.${key}`)['aria-describedby'] ??
                  'recipe-nutrition-help'
                }
                value={draft.nutrition?.[key] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    nutrition: {
                      ...(draft.nutrition ?? unknownNutrition()),
                      [key]: numberValue(event.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </section>
      <RecipeEstimation
        draft={draft}
        baseline={baseline}
        hasNutrition={
          draft.nutrition !== undefined &&
          Object.values(draft.nutrition).some((value) => value !== null)
        }
        available={aiAvailable}
        onNutrition={(nutrition) =>
          setDraft((current) => ({ ...current, nutrition }))
        }
        onMetadata={(metadata) =>
          setDraft((current) => ({ ...current, ...metadata }))
        }
      />
      <div className="form-actions">
        <p>Saved on this device. Ready when you are.</p>
        <button
          className="button secondary"
          type="button"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save recipe'}
        </button>
      </div>
    </form>
  );
}
