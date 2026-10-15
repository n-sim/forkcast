import {
  formatQuantity,
  unitLabels,
  type AllocationCheck,
  type RecipeDraft,
} from './domain';

export function AllocationChecks({
  recipe,
  checks,
}: {
  recipe: RecipeDraft;
  checks: AllocationCheck[];
}) {
  return (
    <section
      className="allocation-checks"
      aria-label="Allocation checks"
      aria-live="polite"
    >
      <h3>Allocation checks</h3>
      {checks.length === 0 ? (
        <p>All ingredient totals are fully allocated.</p>
      ) : (
        <ul>
          {checks.map((check) => (
            <li key={check.ingredientId}>
              {
                recipe.ingredients.find(
                  (ingredient) => ingredient.id === check.ingredientId,
                )?.name
              }
              : {formatQuantity(check.allocated)} /{' '}
              {formatQuantity(check.total)} {unitLabels[check.unit]} allocated;{' '}
              {formatQuantity(Math.abs(check.difference))}{' '}
              {unitLabels[check.unit]}{' '}
              {check.difference > 0 ? 'unallocated' : 'overallocated'}.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
