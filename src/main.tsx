import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializeDomain } from './domain';
import {
  loadRecipes,
  loadRecipeCoverPhotos,
  loadPersonalRecipeRatings,
  loadCookingSessions,
} from './recipe-store';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

async function start() {
  try {
    await initializeDomain();
    const [recipes, coverPhotos, ratings, sessions] = await Promise.all([
      loadRecipes(),
      loadRecipeCoverPhotos(),
      loadPersonalRecipeRatings(),
      loadCookingSessions(),
    ]);
    root.render(
      <App
        initialRecipes={recipes}
        initialCoverPhotos={coverPhotos}
        initialRatings={ratings}
        initialCookingSessions={sessions}
      />,
    );
  } catch {
    root.render(
      <main className="startup-error">
        <h1>We couldn’t open your recipe collection</h1>
        <p>
          Check that browser storage is available, then reload. Your stored data
          has been kept.
        </p>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          Reload application
        </button>
      </main>,
    );
  }
}

void start();
