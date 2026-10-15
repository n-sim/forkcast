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
  subscribeToRecipeChanges,
} from './recipe-store';
import { RecipeForm } from './RecipeForm';
import { RecipeCoverPhoto, RecipePhotoEditor } from './RecipePhoto';
import { PersonalRecipeRating } from './RecipeRating';
import { cookingUrl, startCooking, type CookingSession } from './cooking';
import { CookingView } from './CookingView';
import { CookingConflictDialog } from './CookingConflictDialog';

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
  sessions,
  onStartCooking,
}: {
  recipe: Recipe;
  photo?: Blob;
  onSavePhoto: (photo: Blob | null) => Promise<void>;
  rating?: RecipeRating;
  onSaveRating: (value: number | null) => Promise<void>;
  sessions: CookingSession[];
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
        </div>
        <a className="button secondary" href={`${recipeUrl(recipe.id)}/edit`}>
          Edit recipe
        </a>
      </div>
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
      {sessions.map((session) => (
        <p key={session.id}>
          <a href={cookingUrl(session.id)}>Resume cooking</a> ·{' '}
          {session.portions} portions · Step {session.currentStep + 1} of{' '}
          {session.recipe.steps.length}
        </p>
      ))}
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
  const [coverPhotos, setCoverPhotos] = useState(initialCoverPhotos);
  const [ratings, setRatings] = useState(initialRatings);
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
        void loadRecipes()
          .then((recipes) => {
            setRecipes(recipes);
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
  const route = useSyncExternalStore(
    subscribeToRoute,
    () => window.location.hash || '#/',
  );
  const editing = route.endsWith('/edit');
  const selected = recipes.find(
    (recipe) => recipeUrl(recipe.id) === (editing ? route.slice(0, -5) : route),
  );
  const selectedSession = sessions.find(
    (session) => cookingUrl(session.id) === route,
  );

  useEffect(() => {
    document.title = `${selectedSession?.recipe.name ?? selected?.name ?? (route === '#/recipes/new' ? 'New recipe' : 'Your recipe collection')} · Forkcast`;
  }, [route, selected, selectedSession]);

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
    await saveRecipe(recipe);
    setRecipes((current) => [
      ...current.filter((item) => item.id !== recipe.id),
      recipe,
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
        </nav>
        <div className="device-note">
          <span className="status-dot" />
          On this device
          <p>
            Your recipes stay in your browser.
            <br />
            No account needed.
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>Your everyday kitchen companion</span>
          <span className="local-badge">
            <span className="status-dot" />
            Standalone
          </span>
        </header>
        <main id="main-content" tabIndex={-1}>
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
          {selectedSession ? (
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
              key={selected.id}
              recipe={selected}
              sessions={sessions.filter(
                (session) => session.recipe.id === selected.id,
              )}
              onStartCooking={async (portions, displayUnits) => {
                const session = startCooking(selected, portions, displayUnits);
                await beginSession(session);
              }}
              photo={coverPhotos[selected.id]}
              rating={ratings[selected.id]}
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
                await saveRecipeCoverPhoto(selected.id, photo);
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
              {sessions.length > 0 && (
                <section className="panel" aria-label="Cooking sessions">
                  <h2>Cooking sessions</h2>
                  <ul className="session-list">
                    {sessions.map((session) => (
                      <li key={session.id}>
                        <a href={cookingUrl(session.id)}>
                          Resume {session.recipe.name}
                        </a>{' '}
                        · {session.portions} portions · Step{' '}
                        {session.currentStep + 1} of{' '}
                        {session.recipe.steps.length}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
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
                        {ratings[recipe.id] && (
                          <p>Your rating: {ratings[recipe.id]!.value} / 5</p>
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
      </div>
    </div>
  );
}
