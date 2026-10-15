import { nutrients, type Nutrition } from './food-log';
import { nutritionValue } from './nutrition';

export function NutritionBrief({ perPortion }: { perPortion: Nutrition }) {
  return (
    <p className="section-note">
      Recipe per portion:{' '}
      {nutrients
        .map(
          ({ key, label, unit }) =>
            `${label}: ${nutritionValue(perPortion[key], unit)}`,
        )
        .join(' · ')}
    </p>
  );
}
