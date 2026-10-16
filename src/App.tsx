import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  calculateRecipe,
  formatQuantity,
  unitLabels,
  difficultyLabels,
  type DisplayUnits,
  type Recipe,
  type RecipeRating,
} from './domain';
import {
  saveRecipe,
  saveRecipeCoverPhoto,
  savePersonalRecipeRating,
  saveCookingSession,
  beginCookingSession,
  endCookingSession,
  loadCookingSessions,
  subscribeToCookingChanges,
  loadRecipes,
  loadRecipeCoverPhotos,
  loadPersonalRecipeRatings,
  subscribeToRecipeChanges,
} from './recipe-store';
import { RecipeForm } from './RecipeForm';
import { RecipeCoverPhoto, RecipePhotoEditor } from './RecipePhoto';
import { PersonalRecipeRating } from './RecipeRating';
import { cookingUrl, startCooking, type CookingSession } from './cooking';
import { CookingView } from './CookingView';
import { CookingConflictDialog } from './CookingConflictDialog';
import { SuspendedCookingBar } from './SuspendedCookingBar';
import { BackendAccounts, useBackendConnection } from './BackendAccounts';
import { FoodLog } from './FoodLog';
import { MealPlan } from './MealPlan';
import { ShoppingListView } from './ShoppingList';
import { RecipeNutrition } from './RecipeNutrition';
import { RecipeSync, useRecipeSync } from './RecipeSync';
import { PlanningImportReview } from './PlanningImportReview';
import { PlanningConflicts } from './PlanningConflicts';
import { recipeSyncAccount } from './recipe-sync-store';
import { RecipeConflicts } from './RecipeConflicts';
import { RecipeMetadata } from './RecipeMetadata';

function subscribeToRoute(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function recipeUrl(id: string) {
  return `#/recipes/${id}`;
}

function RecipeDetails({
  recipe,
  photo,
  onSavePhoto,
  rating,
  onSaveRating,
  onStartCooking,
  loggedNutritionVersionId,
}: {
  recipe: Recipe;
  photo?: Blob;
  onSavePhoto: (photo: Blob | null) => Promise<void>;
  rating?: RecipeRating;
  onSaveRating: (value: number | null) => Promise<void>;
  loggedNutritionVersionId: string | null;
  onStartCooking: (
    portions: number,
    displayUnits: DisplayUnits,
  ) => Promise<void>;
}) {
  const [portions, setPortions] = useState(String(recipe.basePortions));
  const [displayUnits, setDisplayUnits] = useState<DisplayUnits>('metric');
  const [starting, setStarting] = useState(false);
  const [cookingError, setCookingError] = useState('');
  let quantities = null;
  let quantityError = '';
  try {
    quantities = calculateRecipe(recipe, Number(portions), displayUnits);
  } catch (error) {
    quantityError = String(error);
  }

  async function cook() {
    setStarting(true);
    setCookingError('');
    try {
      await onStartCooking(Number(portions), displayUnits);
    } catch {
      setCookingError(
        'The cooking session could not be saved. Please try again.',
      );
    } finally {
      setStarting(false);
    }
  }
  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">From your collection</p>
          <h1>{recipe.name}</h1>
          {recipe.label && <p className="recipe-label">{recipe.label}</p>}
        </div>
        <a className="button secondary" href={`${recipeUrl(recipe.id)}/edit`}>
          Edit recipe
        </a>
      </div>
      {loggedNutritionVersionId &&
        loggedNutritionVersionId !== recipe.nutritionVersionId && (
          <p
            className="nutrition-version-notice"
            role="status"
            aria-label="Food-log nutrition"
          >
            This food-log entry uses older nutrition. You are viewing the
            current recipe. The entry keeps its logged values.
          </p>
        )}
      <RecipeMetadata recipe={recipe} />
      <div className="recipe-personalization">
        <RecipePhotoEditor
          recipeName={recipe.name}
          photo={photo}
          onSave={onSavePhoto}
        />
        <PersonalRecipeRating value={rating?.value} onSave={onSaveRating} />
      </div>
      <section
        className="panel quantity-controls"
        aria-label="Cooking quantities"
      >
        <label>
          Cooking portions
          <input
            type="number"
            step="any"
            value={portions}
            aria-invalid={Boolean(quantityError)}
            aria-describedby={quantityError ? 'quantity-error' : undefined}
            onChange={(event) => setPortions(event.target.value)}
          />
        </label>
        <label>
          Display units
          <select
            aria-label="Display units"
            value={displayUnits}
            onChange={(event) =>
              setDisplayUnits(event.target.value as DisplayUnits)
            }
          >
            <option value="metric">Metric</option>
            <option value="us">US customary</option>
            <option value="original">As entered</option>
          </select>
        </label>
        <p className="section-note">
          Scale ingredient totals and step allocations for this cooking. Base
          yield stays {recipe.basePortions} portions.
        </p>
        <button
          className="button primary"
          disabled={starting || Boolean(quantityError)}
          onClick={() => void cook()}
        >
          {starting ? 'Starting…' : 'Start cooking'}
        </button>
      </section>
      {cookingError && (
        <p className="error-banner" role="alert">
          {cookingError}
        </p>
      )}
      {quantityError && (
        <p role="alert" id="quantity-error" className="error-banner">
          {quantityError}
        </p>
      )}
      {quantities && (
        <>
          <div className="recipe-content">
            <section className="panel" aria-labelledby="ingredients-heading">
              <p className="eyebrow">What you’ll need</p>
              <h2 id="ingredients-heading">Ingredients</h2>
              <p className="section-note">
                For {portions} {Number(portions) === 1 ? 'portion' : 'portions'}
              </p>
              <ul className="ingredient-list" aria-label="Ingredients">
                {quantities.ingredients.map((ingredient) => (
                  <li key={ingredient.id}>
                    <strong>
                      {formatQuantity(ingredient.quantity)}{' '}
                      {unitLabels[ingredient.unit]}
                    </strong>{' '}
                    <span>{ingredient.name}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel" aria-labelledby="steps-heading">
              <p className="eyebrow">Let’s make it</p>
              <h2 id="steps-heading">Cooking steps</h2>
              <ol className="cooking-steps" aria-label="Cooking steps">
                {quantities.steps.map((step) => (
                  <li key={step.id}>
                    {step.instruction}
                    {step.allocations.map((allocation) => (
                      <div
                        className="step-amount"
                        key={allocation.ingredientId}
                      >
                        {formatQuantity(allocation.quantity!)}{' '}
                        {unitLabels[allocation.unit]}{' '}
                        {
                          recipe.ingredients.find(
                            (ingredient) =>
                              ingredient.id === allocation.ingredientId,
                          )?.name
                        }
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      )}
      <RecipeNutrition recipe={recipe} />
    </article>
  );
}

export function App({
  initialRecipes,
  initialCoverPhotos,
  initialRatings,
  initialCookingSessions,
}: {
  initialRecipes: Recipe[];
  initialCoverPhotos: Record<string, Blob>;
  initialRatings: Record<string, RecipeRating>;
  initialCookingSessions: CookingSession[];
}) {
  const [recipes, setRecipes] = useState(initialRecipes);
  const connection = useBackendConnection();
  const sync = useRecipeSync(connection.config);
  const [coverPhotos, setCoverPhotos] = useState(initialCoverPhotos);
  const [ratings, setRatings] = useState(initialRatings);
  const ratingOwner = recipeSyncAccount(connection.config, sync.binding);
  const visibleRatings = sync.binding
    ? Object.fromEntries(
        Object.entries(ratings).filter(
          ([, rating]) => rating.personId === ratingOwner,
        ),
      )
    : ratings;
  const [sessions, setSessions] = useState(initialCookingSessions);
  const [cookingConflict, setCookingConflict] = useState<{
    proposed: CookingSession;
    existing: CookingSession[];
  } | null>(null);
  const [refreshError, setRefreshError] = useState('');
  useEffect(
    () =>
      subscribeToCookingChanges(() => {
        void loadCookingSessions()
          .then(setSessions)
          .catch(() =>
            setRefreshError(
              'Cooking changes could not be loaded. Reload to try again.',
            ),
          );
      }),
    [],
  );
  useEffect(
    () =>
      subscribeToRecipeChanges(() => {
        void Promise.all([
          loadRecipes(),
          loadRecipeCoverPhotos(),
          loadPersonalRecipeRatings(),
        ])
          .then(([recipes, photos, ratings]) => {
            setRecipes(recipes);
            setCoverPhotos(photos);
            setRatings(ratings);
            setRefreshError('');
          })
          .catch(() =>
            setRefreshError(
              'Recipe changes could not be loaded. Reload to try again.',
            ),
          );
      }),
    [],
  );
  useEffect(() => {
    let active = true;
    setRatings({});
    void loadPersonalRecipeRatings()
      .then((ratings) => {
        if (active) setRatings(ratings);
      })
      .catch(() => {
        if (active)
          setRefreshError(
            'Your personal ratings could not be loaded. Reload to try again.',
          );
      });
    return () => {
      active = false;
    };
  }, [
    connection.config?.url,
    connection.config?.token,
    connection.config?.accountId,
    sync.binding?.url,
    sync.binding?.householdId,
  ]);
  const route = useSyncExternalStore(
    subscribeToRoute,
    () => window.location.hash || '#/',
  );
  const [recipeRoute = route, recipeQuery] = route.split('?');
  const loggedNutritionVersionId = new URLSearchParams(recipeQuery).get(
    'nutritionVersion',
  );
  const settingsOpen = route === '#/settings' || route === '#/backend';
  const foodLogOpen = route === '#/food-log';
  const shoppingOpen = route === '#/shopping-list';
  const conflictsOpen = route === '#/recipe-conflicts';
  const planningConflictsOpen = route === '#/planning-conflicts';
  const planningView =
    route === '#/meal-plan' ? 'week' : route === '#/today' ? 'today' : null;
  const editing = recipeRoute.endsWith('/edit');
  const selected = recipes.find(
    (recipe) =>
      recipeUrl(recipe.id) ===
      (editing ? recipeRoute.slice(0, -5) : recipeRoute),
  );
  const selectedSession = sessions.find(
    (session) => cookingUrl(session.id) === route,
  );
  const suspendedSession =
    !selectedSession &&
    (route === '#/' ||
      selected ||
      route === '#/recipes/new' ||
      foodLogOpen ||
      shoppingOpen ||
      planningView)
      ? sessions[0]
      : undefined;

  useEffect(() => {
    document.title = `${selectedSession?.recipe.name ?? selected?.name ?? (settingsOpen ? 'Settings' : planningConflictsOpen ? 'Review planning conflicts' : conflictsOpen ? 'Review recipe conflicts' : foodLogOpen ? 'Food log' : shoppingOpen ? 'Shopping list' : planningView === 'today' ? 'Today’s cooking' : planningView ? 'Your weekly meal plan' : route === '#/recipes/new' ? 'New recipe' : 'Your recipe collection')} · Forkcast`;
  }, [
    route,
    selected,
    selectedSession,
    settingsOpen,
    conflictsOpen,
    planningConflictsOpen,
    foodLogOpen,
    shoppingOpen,
    planningView,
  ]);

  async function saveSession(session: CookingSession) {
    await saveCookingSession(session);
    setSessions((current) => [
      ...current.filter((item) => item.id !== session.id),
      session,
    ]);
  }

  function leaveCooking(session: CookingSession) {
    window.location.hash = recipes.some(
      (recipe) => recipe.id === session.recipe.id,
    )
      ? recipeUrl(session.recipe.id)
      : '#/';
  }

  async function endSession(
    session: CookingSession,
    outcome: 'finished' | 'canceled',
  ) {
    await endCookingSession(session.id, outcome);
    setSessions((current) => current.filter((item) => item.id !== session.id));
    leaveCooking(session);
  }

  async function suspendSession(session: CookingSession) {
    await saveSession(session);
    leaveCooking(session);
  }

  async function beginSession(
    proposed: CookingSession,
    cancelSessionIds: string[] = [],
  ) {
    const result = await beginCookingSession(proposed, cancelSessionIds);
    if (!result.session) {
      setSessions(result.conflicts);
      setCookingConflict({ proposed, existing: result.conflicts });
      return;
    }
    setCookingConflict(null);
    setSessions([result.session]);
    window.location.hash = cookingUrl(result.session.id);
  }

  async function save(recipe: Recipe) {
    const saved = await saveRecipe(recipe);
    setRecipes((current) => [
      ...current.filter((item) => item.id !== recipe.id),
      saved,
    ]);
    window.location.hash = recipeUrl(recipe.id);
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="Forkcast home">
          <span className="brand-mark" aria-hidden="true">
            f.
          </span>
          forkcast<span className="brand-dot">.</span>
        </a>
        <p className="brand-tagline">
          A little less planning.
          <br />A little more cooking.
        </p>
        <nav aria-label="Main navigation">
          <a
            className="nav-link"
            href="#/"
            aria-current={route === '#/' ? 'page' : undefined}
          >
            <span aria-hidden="true">▤</span> Recipe collection
          </a>
          <a
            className="nav-link"
            href="#/meal-plan"
            aria-current={planningView === 'week' ? 'page' : undefined}
          >
            <span aria-hidden="true">▦</span> Meal plan
          </a>
          <a
            className="nav-link"
            href="#/today"
            aria-current={planningView === 'today' ? 'page' : undefined}
          >
            <span aria-hidden="true">☀</span> Today
          </a>
          <a
            className="nav-link"
            href="#/food-log"
            aria-current={foodLogOpen ? 'page' : undefined}
          >
            <span aria-hidden="true">◷</span> Food log
          </a>
          <a
            className="nav-link"
            href="#/shopping-list"
            aria-current={shoppingOpen ? 'page' : undefined}
          >
            <span aria-hidden="true">▧</span> Shopping list
          </a>
        </nav>
        <div className="sidebar-footer">
          <div className="device-note">
            <span className="status-dot" />
            {sync.binding ? 'Household collection' : 'On this device'}
            <p>
              {sync.binding
                ? 'Recipes synchronize when connected.'
                : 'Your recipes stay in your browser.'}
              <br />
              No account needed.
            </p>
          </div>
          <nav aria-label="Settings navigation">
            <a
              className="nav-link"
              href="#/settings"
              aria-current={settingsOpen ? 'page' : undefined}
            >
              <span aria-hidden="true">⚙</span> Settings
            </a>
          </nav>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>Your everyday kitchen companion</span>
          <span
            className="local-badge"
            role="status"
            aria-label="Backend connection"
          >
            <span className="status-dot" />
            {connection.label}
          </span>
        </header>
        <main id="main-content" tabIndex={-1}>
          {sync.importReview && (
            <PlanningImportReview
              review={sync.importReview}
              config={connection.config}
              recipes={recipes}
              onRefresh={sync.sync}
            />
          )}
          {cookingConflict && (
            <CookingConflictDialog
              sessions={cookingConflict.existing}
              onKeep={() => setCookingConflict(null)}
              onReplace={() =>
                beginSession(
                  cookingConflict.proposed,
                  cookingConflict.existing.map((session) => session.id),
                )
              }
            />
          )}
          {refreshError && (
            <p className="error-banner" role="alert">
              {refreshError}
            </p>
          )}
          {sync.conflicts > 0 && (
            <p
              role="status"
              aria-label="Recipe edit conflicts"
              className="nutrition-version-notice"
            >
              {sync.conflicts} unresolved competing{' '}
              {sync.conflicts === 1 ? 'edit' : 'edits'}. Both revisions are
              retained for conflict resolution.{' '}
              <a href="#/recipe-conflicts">Review recipe conflicts</a>
            </p>
          )}
          {!!sync.planning?.snapshot.conflicts.length && (
            <p
              role="status"
              aria-label="Planning edit conflicts"
              className="nutrition-version-notice"
            >
              {sync.planning.snapshot.conflicts.length} unresolved competing
              planning changes.{' '}
              <a href="#/planning-conflicts">Review planning conflicts</a>
            </p>
          )}
          {planningConflictsOpen ? (
            <PlanningConflicts
              conflicts={sync.planning?.snapshot.conflicts ?? []}
              data={
                sync.planning?.snapshot.data ?? {
                  cookings: {},
                  shoppingList: null,
                }
              }
              recipes={recipes}
              config={ratingOwner ? connection.config : null}
              onRefresh={sync.sync}
            />
          ) : conflictsOpen ? (
            <RecipeConflicts
              conflicts={sync.alternatives}
              config={ratingOwner ? connection.config : null}
              onRefresh={sync.sync}
            />
          ) : planningView ? (
            <MealPlan
              key={planningView}
              recipes={recipes}
              view={planningView}
            />
          ) : shoppingOpen ? (
            <ShoppingListView />
          ) : foodLogOpen ? (
            <FoodLog recipes={recipes} />
          ) : settingsOpen ? (
            <article>
              <h1>Settings</h1>
              <BackendAccounts connection={connection} />
              <RecipeSync
                config={connection.config}
                session={connection.session}
                sync={sync}
              />
            </article>
          ) : selectedSession ? (
            <CookingView
              key={selectedSession.id}
              session={selectedSession}
              currentRecipe={recipes.find(
                (recipe) => recipe.id === selectedSession.recipe.id,
              )}
              onSave={saveSession}
              onFinish={() => endSession(selectedSession, 'finished')}
              onCancel={() => endSession(selectedSession, 'canceled')}
              onSuspend={() => suspendSession(selectedSession)}
            />
          ) : route === '#/recipes/new' || (selected && editing) ? (
            <RecipeForm
              key={selected?.id ?? 'new'}
              recipe={selected}
              onSave={save}
              onCancel={() => {
                window.location.hash = selected ? recipeUrl(selected.id) : '#/';
              }}
            />
          ) : selected ? (
            <RecipeDetails
              key={`${selected.id}:${sync.binding ? (connection.config?.accountId ?? 'signed-out') : 'local'}`}
              recipe={selected}
              loggedNutritionVersionId={loggedNutritionVersionId}
              onStartCooking={async (portions, displayUnits) => {
                const session = startCooking(selected, portions, displayUnits);
                await beginSession(session);
              }}
              photo={coverPhotos[selected.id]}
              rating={visibleRatings[selected.id]}
              onSaveRating={async (value) => {
                const rating = await savePersonalRecipeRating(
                  selected.id,
                  value,
                );
                setRatings((current) => {
                  const next = { ...current };
                  if (rating) next[selected.id] = rating;
                  else delete next[selected.id];
                  return next;
                });
              }}
              onSavePhoto={async (photo) => {
                await saveRecipeCoverPhoto(selected, photo);
                setCoverPhotos((current) => {
                  const next = { ...current };
                  if (photo) next[selected.id] = photo;
                  else delete next[selected.id];
                  return next;
                });
              }}
            />
          ) : route !== '#/' ? (
            <div className="empty-state">
              <h1>
                {route.startsWith('#/cooking/')
                  ? 'Cooking session unavailable'
                  : 'Recipe not found'}
              </h1>
              <p>
                {route.startsWith('#/cooking/')
                  ? 'This cooking session has ended or is not available to you on this device.'
                  : 'This recipe is not in this device’s collection.'}
              </p>
              <a className="button primary" href="#/">
                Back to collection
              </a>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">Good food, on repeat</p>
                  <h1>Your recipe collection</h1>
                  <p>The dishes you love, all in one place.</p>
                </div>
                <button
                  className="button primary"
                  aria-label="New recipe"
                  onClick={() => {
                    window.location.hash = '#/recipes/new';
                  }}
                >
                  + New recipe
                </button>
              </div>
              <div className="collection-count">
                {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'}
                <span>Made by you. Kept for next time.</span>
              </div>
              {recipes.length === 0 ? (
                <div className="empty-state">
                  <div className="bowl" aria-hidden="true">
                    ♨
                  </div>
                  <p className="eyebrow">Room for something delicious</p>
                  <h2>Your next favourite starts here.</h2>
                  <p>
                    Add your first recipe and make it part of your everyday.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => {
                      window.location.hash = '#/recipes/new';
                    }}
                  >
                    Create your first recipe
                  </button>
                </div>
              ) : (
                <div className="recipe-grid">
                  {[...recipes]
                    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
                    .map((recipe) => (
                      <a
                        className="recipe-card"
                        key={recipe.id}
                        href={recipeUrl(recipe.id)}
                      >
                        {coverPhotos[recipe.id] ? (
                          <RecipeCoverPhoto
                            photo={coverPhotos[recipe.id]!}
                            recipeName={recipe.name}
                            className="card-cover"
                          />
                        ) : (
                          <span className="card-icon" aria-hidden="true">
                            ▤
                          </span>
                        )}
                        <p className="eyebrow">Your recipe</p>
                        <h2>{recipe.name}</h2>
                        {recipe.label && (
                          <p className="recipe-label">{recipe.label}</p>
                        )}
                        {visibleRatings[recipe.id] && (
                          <p>
                            Your rating: {visibleRatings[recipe.id]!.value} / 5
                          </p>
                        )}
                        <p>
                          {recipe.basePortions} portions
                          <span aria-hidden="true"> · </span>
                          {recipe.difficulty
                            ? difficultyLabels[recipe.difficulty]
                            : 'Difficulty not specified'}
                        </p>
                        <div className="card-footer">
                          <span>
                            {recipe.totalMinutes === null
                              ? 'Time not specified'
                              : `${recipe.totalMinutes} min total`}
                          </span>
                          <span aria-hidden="true">↗</span>
                        </div>
                      </a>
                    ))}
                </div>
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          A collection worth coming back to.
          <span>Forkcast · Cook your way.</span>
        </footer>
        {suspendedSession && <SuspendedCookingBar session={suspendedSession} />}
      </div>
    </div>
  );
}
