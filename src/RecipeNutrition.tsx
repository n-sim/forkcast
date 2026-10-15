import type { Recipe } from './domain';
import { nutrients } from './food-log';
import { nutritionValue, recipeNutrition, unknownNutrition } from './nutrition';

export function RecipeNutrition({ recipe }: { recipe: Recipe }) {
  return (
    <div className="recipe-content">
      {[
        {
          title: 'Whole-recipe nutrition',
          values: recipe.nutrition ?? unknownNutrition(),
        },
        { title: 'Nutrition per portion', values: recipeNutrition(recipe) },
      ].map(({ title, values }) => (
        <section className="panel" aria-label={title} key={title}>
          <h2>{title}</h2>
          <p className="section-note">
            {title === 'Whole-recipe nutrition'
              ? `For the base yield of ${recipe.basePortions} portions.`
              : 'For one portion, independently of how much you cook.'}
          </p>
          <dl className="recipe-metadata">
            {nutrients.map(({ key, label, unit }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{nutritionValue(values[key], unit)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
