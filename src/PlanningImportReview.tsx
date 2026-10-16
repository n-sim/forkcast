import { useState } from 'react';
import type { BackendConfig } from './backend-client';
import type { Recipe } from './domain';
import type { PlanningImport } from './planning-sync-store';
import { importPlanning } from './planning-sync';

export function PlanningImportReview({
  review,
  config,
  recipes,
  onRefresh,
}: {
  review: PlanningImport;
  config: BackendConfig | null;
  recipes: Recipe[];
  onRefresh: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(
    () => new Set(Object.keys(review.local.cookings)),
  );
  const [deviceList, setDeviceList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function finish(discard: boolean) {
    if (!config) return;
    setBusy(true);
    setError('');
    try {
      await importPlanning(
        config,
        review,
        discard ? undefined : { cookingIds: [...selected], deviceList },
      );
      onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      onRefresh();
    } finally {
      setBusy(false);
    }
  }
  if (dismissed)
    return (
      <p className="nutrition-version-notice">
        Your device planning data is waiting for review.{' '}
        <button
          className="button secondary"
          onClick={() => setDismissed(false)}
        >
          Review device planning data
        </button>
      </p>
    );
  return (
    <section className="panel" aria-labelledby="planning-import-heading">
      <h2 id="planning-import-heading">Review device planning data</h2>
      <p>
        This device has an existing meal plan or shopping list. Choose what to
        bring into your household before using shared planning.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <fieldset disabled={busy || !config?.token}>
        <legend>Planned cookings to add</legend>
        {Object.values(review.local.cookings).map((cooking) => {
          const duplicate = Object.values(review.household.data.cookings).some(
            (shared) =>
              shared.recipeId === cooking.recipeId &&
              shared.cookingDate === cooking.cookingDate &&
              shared.cookingTime === cooking.cookingTime,
          );
          const name =
            recipes.find((recipe) => recipe.id === cooking.recipeId)?.name ??
            'Recipe unavailable';
          return (
            <label key={cooking.id}>
              <input
                type="checkbox"
                checked={selected.has(cooking.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(cooking.id);
                    else next.delete(cooking.id);
                    return next;
                  })
                }
              />
              {name} · {cooking.cookingDate} · {cooking.portions} portions
              {duplicate && (
                <strong> · Possible duplicate in household plan</strong>
              )}
            </label>
          );
        })}
        {!Object.keys(review.local.cookings).length && (
          <p>No device planned cookings.</p>
        )}
        <label>
          <input
            type="radio"
            name="import-shopping-list"
            checked={!deviceList}
            onChange={() => setDeviceList(false)}
          />
          Keep household shopping list
        </label>
        <p>
          {review.household.data.shoppingList
            ? `${review.household.data.shoppingList.startDate} through ${review.household.data.shoppingList.endDate}; ${review.household.data.shoppingList.items.length + review.household.data.shoppingList.manualItems.length} items`
            : 'The household has no shopping list yet.'}
        </p>
        {review.local.shoppingList && (
          <>
            <label>
              <input
                type="radio"
                name="import-shopping-list"
                checked={deviceList}
                onChange={() => setDeviceList(true)}
              />
              Replace with device shopping list
            </label>
            <p>
              {review.local.shoppingList.startDate} through{' '}
              {review.local.shoppingList.endDate}; replaces the household’s
              current list.
            </p>
            <ul>
              {[
                ...review.local.shoppingList.items,
                ...review.local.shoppingList.manualItems,
              ].map((item) => (
                <li key={item.id}>
                  {item.name} · {item.quantity} {item.unit}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="form-actions">
          <button className="button primary" onClick={() => void finish(false)}>
            Import selected data
          </button>
          <button
            className="button secondary"
            onClick={() => void finish(true)}
          >
            Continue with household data
          </button>
          <button
            className="button secondary"
            onClick={() => setDismissed(true)}
          >
            Cancel
          </button>
        </div>
        <p className="section-note">
          Continue with household data discards this device’s meal plan and
          shopping list. Cancelling keeps both the device and household data
          untouched.
        </p>
      </fieldset>
    </section>
  );
}
