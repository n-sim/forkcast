import { useState } from 'react';
import type { BackendConfig } from './backend-client';
import { formatQuantity, unitLabels } from './domain';
import { RecipeMetadata } from './RecipeMetadata';
import { RecipeCoverPhoto } from './RecipePhoto';
import { RecipeNutrition } from './RecipeNutrition';
import { chooseCurrentRecipe } from './recipe-sync';
import type { RecipeConflict, RecipeRevision } from './recipe-sync-store';

function RevisionContents({ revision }: { revision: RecipeRevision }) {
  const { recipe, coverPhoto } = revision;
  return (
    <>
      <h4>{recipe.name}</h4>
      {recipe.label && <p className="recipe-label">{recipe.label}</p>}
      {coverPhoto && (
        <RecipeCoverPhoto
          photo={coverPhoto}
          recipeName={recipe.name}
          className="recipe-cover"
        />
      )}
      <RecipeMetadata recipe={recipe} />
      <h4>Ingredients</h4>
      <ul className="ingredient-list" aria-label="Ingredients">
        {recipe.ingredients.map((ingredient) => (
          <li key={ingredient.id}>
            {formatQuantity(ingredient.quantity)} {unitLabels[ingredient.unit]}{' '}
            {ingredient.name}
          </li>
        ))}
      </ul>
      <h4>Cooking steps</h4>
      <ol className="cooking-steps" aria-label="Cooking steps">
        {recipe.steps.map((step) => (
          <li key={step.id}>
            {step.instruction}
            {step.allocations.map((allocation) => (
              <div className="step-amount" key={allocation.ingredientId}>
                {formatQuantity(allocation.quantity!)}{' '}
                {unitLabels[allocation.unit]}{' '}
                {
                  recipe.ingredients.find(
                    (ingredient) => ingredient.id === allocation.ingredientId,
                  )?.name
                }
              </div>
            ))}
          </li>
        ))}
      </ol>
      <RecipeNutrition recipe={recipe} />
    </>
  );
}

export function RecipeConflicts({
  conflicts,
  config,
  onRefresh,
}: {
  conflicts: RecipeConflict[];
  config: BackendConfig | null;
  onRefresh: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  async function choose(conflict: RecipeConflict, revisionId: string) {
    if (!config) return;
    setChoosing(true);
    setError('');
    try {
      await chooseCurrentRecipe(config, conflict, revisionId);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setChoosing(false);
      onRefresh();
    }
  }
  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Household recipes</p>
          <h1>Review recipe conflicts</h1>
        </div>
        <a className="button secondary" href="#/">
          Back to recipes
        </a>
      </div>
      <p>
        These recipes were edited separately. Inspect the alternatives and
        choose which contents become current for your household. Retained
        food-log nutrition stays unchanged.
      </p>
      {!config?.token && (
        <p>Sign in to your household to choose the current recipe.</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!conflicts.length && <p>No unresolved recipe conflicts.</p>}
      {conflicts.map((conflict) => (
        <section key={conflict.recipeId} aria-label="Competing recipe edits">
          <h2>
            {conflict.revisions.find(
              (revision) => revision.id === conflict.currentRevisionId,
            )?.recipe.name ?? 'Recipe'}
          </h2>
          <a href={`#/recipes/${conflict.recipeId}`}>View current recipe</a>
          <div className="conflict-alternatives">
            {conflict.revisions.map((revision, index) => (
              <section
                className="panel"
                key={revision.id}
                aria-label={`Revision ${index + 1}`}
              >
                <h3>Revision {index + 1}</h3>
                {revision.id === conflict.currentRevisionId && (
                  <p className="eyebrow">Current recipe</p>
                )}
                <RevisionContents revision={revision} />
                <button
                  className="button primary"
                  disabled={choosing || !config?.token}
                  onClick={() => void choose(conflict, revision.id)}
                >
                  Make current
                </button>
              </section>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
