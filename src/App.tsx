import { useEffect, useState, useSyncExternalStore } from 'react';
import { difficultyLabels, type Recipe } from './domain';
import { saveRecipe } from './recipe-store';
import { RecipeForm } from './RecipeForm';

function subscribeToRoute(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function recipeUrl(id: string) {
  return `#/recipes/${id}`;
}

function RecipeDetails({ recipe }: { recipe: Recipe }) {
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
      <div className="recipe-content">
        <section className="panel" aria-labelledby="ingredients-heading">
          <p className="eyebrow">What you’ll need</p>
          <h2 id="ingredients-heading">Ingredients</h2>
          <p className="section-note">
            For {recipe.basePortions}{' '}
            {recipe.basePortions === 1 ? 'portion' : 'portions'}
          </p>
          <ul className="ingredient-list" aria-label="Ingredients">
            {recipe.ingredients.map((ingredient) => (
              <li key={ingredient.id}>
                <strong>
                  {ingredient.quantity} {ingredient.unit}
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
            {recipe.steps.map((step) => (
              <li key={step.id}>{step.instruction}</li>
            ))}
          </ol>
        </section>
      </div>
    </article>
  );
}

export function App({ initialRecipes }: { initialRecipes: Recipe[] }) {
  const [recipes, setRecipes] = useState(initialRecipes);
  const route = useSyncExternalStore(
    subscribeToRoute,
    () => window.location.hash || '#/',
  );
  const editing = route.endsWith('/edit');
  const selected = recipes.find(
    (recipe) => recipeUrl(recipe.id) === (editing ? route.slice(0, -5) : route),
  );

  useEffect(() => {
    document.title = `${selected?.name ?? (route === '#/recipes/new' ? 'New recipe' : 'Your recipe collection')} · Forkcast`;
  }, [route, selected]);

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
          {route === '#/recipes/new' || (selected && editing) ? (
            <RecipeForm
              key={selected?.id ?? 'new'}
              recipe={selected}
              onSave={save}
              onCancel={() => {
                window.location.hash = selected ? recipeUrl(selected.id) : '#/';
              }}
            />
          ) : selected ? (
            <RecipeDetails recipe={selected} />
          ) : route !== '#/' ? (
            <div className="empty-state">
              <h1>Recipe not found</h1>
              <p>This recipe is not in this device’s collection.</p>
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
                        <span className="card-icon" aria-hidden="true">
                          ▤
                        </span>
                        <p className="eyebrow">Your recipe</p>
                        <h2>{recipe.name}</h2>
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
