import { useEffect, useState } from 'react';
import { localDateTime } from './food-log';
import {
  cookingPeriodLabels,
  cookingPeriodOf,
  cookingTimeRank,
  type PlannedCooking,
  type PlanningRecipe,
} from './planning';
import {
  loadPlannedCookings,
  savePlannedCooking,
  removePlannedCooking,
  subscribeToPlanningChanges,
  type EditablePlannedCooking,
} from './planning-store';
import { PlannedCookingForm } from './PlannedCookingForm';
import { recipeNutrition } from './nutrition';
import { NutritionBrief } from './NutritionBrief';

const firstDate = '0001-01-01';
const lastDate = '9999-12-31';

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return localDateTime(value).split('T')[0]!;
}

function monday(date: string) {
  const day = new Date(`${date}T12:00:00`).getDay();
  return shiftDate(date, -((day + 6) % 7));
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
function dateLabel(date: string) {
  return dateFormat.format(new Date(`${date}T12:00:00`));
}

function useToday() {
  const [today, setToday] = useState(() => localDateTime().slice(0, 10));
  useEffect(() => {
    const refresh = () => setToday(localDateTime().slice(0, 10));
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return today;
}

function PlannedCookingCard({
  cooking,
  recipe,
  onEdit,
  onRemove,
  editing,
}: {
  cooking: PlannedCooking;
  recipe?: PlanningRecipe;
  onEdit: () => void;
  onRemove: () => void;
  editing: boolean;
}) {
  const perPortion = recipe ? recipeNutrition(recipe) : null;
  const hasNutrition =
    perPortion && Object.values(perPortion).some((value) => value !== null);
  return (
    <article
      className="planned-cooking"
      aria-label={recipe?.name ?? 'Recipe unavailable'}
    >
      {cooking.cookingTime && (
        <p className="eyebrow">
          {cookingPeriodOf(cooking.cookingTime)
            ? cookingPeriodLabels[cookingPeriodOf(cooking.cookingTime)!]
            : cooking.cookingTime}
        </p>
      )}
      <h4>
        {recipe ? (
          <a href={`#/recipes/${recipe.id}`}>{recipe.name}</a>
        ) : (
          'Recipe unavailable'
        )}
      </h4>
      {recipe?.label && <p className="recipe-label">{recipe.label}</p>}
      <p>
        <strong>
          {cooking.portions} {cooking.portions === 1 ? 'portion' : 'portions'}{' '}
          to cook
        </strong>
      </p>
      {recipe && (
        <>
          <p className="section-note">
            {recipe.activeMinutes === null
              ? 'Active time not specified'
              : `${recipe.activeMinutes} min active`}
            {' · '}
            {recipe.totalMinutes === null
              ? 'Total time not specified'
              : `${recipe.totalMinutes} min total`}
          </p>
          {hasNutrition ? (
            <NutritionBrief perPortion={perPortion} />
          ) : (
            <p className="section-note">Recipe nutrition not available.</p>
          )}
        </>
      )}
      <div className="planned-cooking-actions">
        <button
          className="button secondary"
          disabled={editing}
          onClick={onEdit}
        >
          Edit planned cooking
        </button>
        <button
          className="button secondary"
          disabled={editing}
          onClick={onRemove}
        >
          Remove planned cooking
        </button>
      </div>
    </article>
  );
}

export function MealPlan({ recipes }: { recipes: PlanningRecipe[] }) {
  const today = useToday();
  const [week, setWeek] = useState(() => monday(today));
  const [cookings, setCookings] = useState<EditablePlannedCooking[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDate, setAddDate] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [editingCooking, setEditingCooking] =
    useState<EditablePlannedCooking>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const cookings = await loadPlannedCookings();
        if (active) {
          setCookings(cookings);
          setLoaded(true);
          setError('');
        }
      } catch {
        if (active)
          setError(
            'Your meal plan could not be loaded. Reload to try again. Your stored data has been kept.',
          );
      }
    };
    const unsubscribe = subscribeToPlanningChanges(() => void refresh());
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function save(cooking: PlannedCooking) {
    await savePlannedCooking(cooking, editingCooking?.editBase);
    setCookings(await loadPlannedCookings());
    setWeek(monday(cooking.cookingDate));
    setAdding(false);
    setEditingCooking(undefined);
    setMessage(
      `Planned cooking saved on this device for ${dateLabel(cooking.cookingDate)}.`,
    );
  }

  async function remove(cooking: EditablePlannedCooking) {
    setRemoving(true);
    setError('');
    try {
      await removePlannedCooking(cooking.id, cooking.editBase);
      setCookings(await loadPlannedCookings());
      setMessage('Planned cooking removed.');
    } catch (error) {
      setError(String(error));
    } finally {
      setRemoving(false);
    }
  }

  const dates = Array.from({ length: 7 }, (_, index) =>
    shiftDate(week, index),
  ).filter(
    (date) => date.length === 10 && date >= firstDate && date <= lastDate,
  );

  function startAdding(date?: string) {
    setEditingCooking(undefined);
    setAddDate(date);
    setAdding(true);
    setMessage('');
  }

  function renderDay(date: string) {
    const entries = cookings
      .filter((cooking) => cooking.cookingDate === date)
      .sort(
        (a, b) =>
          cookingTimeRank(a.cookingTime) - cookingTimeRank(b.cookingTime) ||
          a.id.localeCompare(b.id),
      );
    return (
      <section
        className="panel meal-plan-day"
        key={date}
        aria-label={dateLabel(date)}
      >
        <div className="meal-plan-day-heading">
          <h3>
            <time dateTime={date}>{dateLabel(date)}</time>
            {date === today && <small> · Today</small>}
          </h3>
          <button
            className="button secondary"
            aria-label={`Plan cooking on ${dateLabel(date)}`}
            disabled={!loaded || !recipes.length || adding || removing}
            onClick={() => startAdding(date)}
          >
            <span aria-hidden="true">+</span> Add
          </button>
        </div>
        {entries.length ? (
          entries.map((cooking) => (
            <PlannedCookingCard
              key={cooking.id}
              cooking={cooking}
              recipe={recipes.find((recipe) => recipe.id === cooking.recipeId)}
              editing={adding || removing}
              onRemove={() => void remove(cooking)}
              onEdit={() => {
                setEditingCooking(cooking);
                setAdding(true);
                setMessage('');
              }}
            />
          ))
        ) : (
          <p className="section-note">No cooking planned.</p>
        )}
      </section>
    );
  }

  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your household’s cooking schedule</p>
          <h1>Your meal plan</h1>
          <p>
            Plan portions for yourself and your household. Record what you eat
            separately in the food log.
          </p>
        </div>
        <button
          className="button primary"
          disabled={!loaded || !recipes.length || adding || removing}
          onClick={() => startAdding()}
        >
          Plan cooking
        </button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <p role="status" aria-label="Meal plan status">
        {message}
      </p>
      {!loaded && !error && <p role="status">Loading meal plan…</p>}
      {!recipes.length && (
        <p>
          Add a recipe to your <a href="#/">recipe collection</a> to start
          planning.
        </p>
      )}
      {adding && (
        <PlannedCookingForm
          key={editingCooking?.id ?? `new-${addDate ?? ''}`}
          recipes={recipes}
          cooking={editingCooking}
          date={addDate ?? (dates.includes(today) ? today : week)}
          onSave={save}
          onCancel={() => setAdding(false)}
        />
      )}
      {loaded && (
        <section aria-labelledby="meal-plan-today-heading">
          <h2 id="meal-plan-today-heading">Today</h2>
          <div className="meal-plan-days">{renderDay(today)}</div>
        </section>
      )}
      <section aria-labelledby="meal-plan-week-heading">
        <h2 id="meal-plan-week-heading">
          {week === monday(today) ? 'This week' : 'Week of ' + dateLabel(week)}
        </h2>
        <section
          className="panel quantity-controls"
          aria-label="Week navigation"
        >
          <button
            className="button secondary"
            disabled={adding || week <= monday(firstDate)}
            onClick={() => setWeek(shiftDate(week, -7))}
          >
            Previous week
          </button>
          <label>
            Week containing
            <input
              type="date"
              min={firstDate}
              max={lastDate}
              value={week}
              disabled={adding}
              onChange={(event) => {
                if (event.target.value && event.target.validity.valid)
                  setWeek(monday(event.target.value));
              }}
            />
          </label>
          <button
            className="button secondary"
            disabled={adding || week >= monday(lastDate)}
            onClick={() => setWeek(shiftDate(week, 7))}
          >
            Next week
          </button>
          <button
            className="button secondary"
            disabled={adding}
            onClick={() => setWeek(monday(today))}
          >
            This week
          </button>
        </section>
        {loaded && (
          <div className="meal-plan-days meal-plan-week">
            {dates
              .filter((date) => date !== today)
              .map((date) => renderDay(date))}
          </div>
        )}
      </section>
    </article>
  );
}
