import {
  unitLabels,
  type CookingStep,
  type IngredientAllocation,
  type RecipeDraft,
  type Unit,
} from './domain';

export function StepAllocations({
  step,
  index,
  ingredients,
  onChange,
  fieldStatus,
}: {
  step: CookingStep;
  index: number;
  ingredients: RecipeDraft['ingredients'];
  onChange: (allocations: IngredientAllocation[]) => void;
  fieldStatus: (path: string) => {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  };
}) {
  function update(index: number, changes: Partial<IngredientAllocation>) {
    onChange(
      step.allocations.map((allocation, i) =>
        i === index ? { ...allocation, ...changes } : allocation,
      ),
    );
  }
  return (
    <div className="step-allocations">
      {step.allocations.map((allocation, allocationIndex) => {
        const label = `Step ${index + 1} allocation ${allocationIndex + 1}`;
        const path = `steps.${index}.allocations.${allocationIndex}`;
        return (
          <fieldset className="allocation-row" key={allocationIndex}>
            <legend className="sr-only">{label}</legend>
            <label>
              Ingredient
              <select
                {...fieldStatus(`${path}.ingredientId`)}
                aria-label={`${label} ingredient`}
                value={allocation.ingredientId}
                onChange={(event) => {
                  const ingredient = ingredients.find(
                    (item) => item.id === event.target.value,
                  );
                  update(allocationIndex, {
                    ingredientId: event.target.value,
                    unit: ingredient?.unit ?? 'g',
                  });
                }}
              >
                <option value="">Choose ingredient</option>
                {ingredients.map((ingredient, i) => (
                  <option key={ingredient.id} value={ingredient.id}>
                    {ingredient.name || `Ingredient ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity
              <input
                {...fieldStatus(`${path}.quantity`)}
                aria-label={`${label} quantity`}
                type="number"
                step="any"
                value={allocation.quantity ?? ''}
                onChange={(event) =>
                  update(allocationIndex, {
                    quantity:
                      event.target.value === ''
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Unit
              <select
                {...fieldStatus(`${path}.unit`)}
                aria-label={`${label} unit`}
                value={allocation.unit}
                onChange={(event) =>
                  update(allocationIndex, { unit: event.target.value as Unit })
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
              type="button"
              className="remove-button"
              aria-label={`Remove ${label.toLowerCase()}`}
              onClick={() =>
                onChange(
                  step.allocations.filter((_, i) => i !== allocationIndex),
                )
              }
            >
              ×
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="button secondary"
        aria-label={`Add allocation to step ${index + 1}`}
        disabled={ingredients.length === 0}
        onClick={() => {
          const ingredient = ingredients.find(
            (item) =>
              !step.allocations.some(
                (allocation) => allocation.ingredientId === item.id,
              ),
          );
          onChange([
            ...step.allocations,
            {
              ingredientId: ingredient?.id ?? '',
              quantity: null,
              unit: ingredient?.unit ?? 'g',
            },
          ]);
        }}
      >
        + Allocate ingredient
      </button>
    </div>
  );
}
