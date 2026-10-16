import { difficultyLabels, type Recipe } from './domain';

export function RecipeMetadata({ recipe }: { recipe: Recipe }) {
  return (
    <dl className="recipe-metadata" aria-label="Recipe details">
      <div>
        <dt>Base yield</dt>
        <dd>
          {recipe.basePortions}{' '}
          {recipe.basePortions === 1 ? 'portion' : 'portions'}
        </dd>
      </div>
      <div>
        <dt>Difficulty</dt>
        <dd>
          {recipe.difficulty
            ? difficultyLabels[recipe.difficulty]
            : 'Not specified'}
        </dd>
      </div>
      <div>
        <dt>Active time</dt>
        <dd>
          {recipe.activeMinutes === null
            ? 'Not specified'
            : `${recipe.activeMinutes} min`}
        </dd>
        <small>Dedicated work or attention</small>
      </div>
      <div>
        <dt>Total time</dt>
        <dd>
          {recipe.totalMinutes === null
            ? 'Not specified'
            : `${recipe.totalMinutes} min`}
        </dd>
        <small>Elapsed time until ready to eat</small>
      </div>
    </dl>
  );
}
