import { useEffect, useState } from 'react';
import { localDateTime } from './food-log';
import { type PlannedCooking, type PlanningRecipe } from './planning';
import {
  loadPlannedCookings,
  savePlannedCooking,
  subscribeToPlanningChanges,
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
  editing,
}: {
  cooking: PlannedCooking;
  recipe?: PlanningRecipe;
  onEdit: () => void;
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
          <time dateTime={`${cooking.cookingDate}T${cooking.cookingTime}`}>
            {cooking.cookingTime}
          </time>
        </p>
      )}
      <h3>
        {recipe ? (
          <a href={`#/recipes/${recipe.id}`}>{recipe.name}</a>
        ) : (
          'Recipe unavailable'
        )}
      </h3>
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
      <button className="button secondary" disabled={editing} onClick={onEdit}>
        Edit planned cooking
      </button>
    </article>
  );
}

export function MealPlan({
  recipes,
  view,
}: {
  recipes: PlanningRecipe[];
  view: 'week' | 'today';
}) {
  const today = useToday();
  const [week, setWeek] = useState(() => monday(today));
  const [cookings, setCookings] = useState<PlannedCooking[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingCooking, setEditingCooking] = useState<PlannedCooking>();
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
    await savePlannedCooking(cooking);
    setCookings((current) => [
      ...current.filter((item) => item.id !== cooking.id),
      cooking,
    ]);
    setWeek(monday(cooking.cookingDate));
    setAdding(false);
    setEditingCooking(undefined);
    setMessage(
      `Planned cooking saved on this device for ${dateLabel(cooking.cookingDate)}.`,
    );
  }

  const dates =
    view === 'today'
      ? [today]
      : Array.from({ length: 7 }, (_, index) => shiftDate(week, index)).filter(
          (date) => date.length === 10 && date >= firstDate && date <= lastDate,
        );
  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your personal cooking schedule</p>
          <h1>
            {view === 'today' ? 'Today’s cooking' : 'Your weekly meal plan'}
          </h1>
          <p>
            Plan portions for yourself and your household. Record what you eat
            separately in the food log.
          </p>
        </div>
        <button
          className="button primary"
          disabled={!loaded || !recipes.length || adding}
          onClick={() => {
            setEditingCooking(undefined);
            setAdding(true);
            setMessage('');
          }}
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
      {view === 'week' && (
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
      )}
      {adding && (
        <PlannedCookingForm
          key={editingCooking?.id ?? 'new'}
          recipes={recipes}
          cooking={editingCooking}
          date={view === 'today' || dates.includes(today) ? today : week}
          onSave={save}
          onCancel={() => setAdding(false)}
        />
      )}
      {loaded && (
        <div
          className={`meal-plan-days ${view === 'week' ? 'meal-plan-week' : ''}`}
        >
          {dates.map((date) => {
            const entries = cookings
              .filter((cooking) => cooking.cookingDate === date)
              .sort(
                (a, b) =>
                  (a.cookingTime ?? '99:99').localeCompare(
                    b.cookingTime ?? '99:99',
                  ) || a.id.localeCompare(b.id),
              );
            return (
              <section
                className="panel meal-plan-day"
                key={date}
                aria-label={dateLabel(date)}
              >
                <h2>
                  <time dateTime={date}>{dateLabel(date)}</time>
                  {date === today && <small> · Today</small>}
                </h2>
                {entries.length ? (
                  entries.map((cooking) => (
                    <PlannedCookingCard
                      key={cooking.id}
                      cooking={cooking}
                      recipe={recipes.find(
                        (recipe) => recipe.id === cooking.recipeId,
                      )}
                      editing={adding}
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
          })}
        </div>
      )}
    </article>
  );
}
