import { useEffect, useRef, useState } from 'react';
import {
  aiModels,
  aiStatus,
  loadAiPreferences,
  saveRecipeModel,
  type AiModel,
  type AiStatus,
} from './ai-client';
import { validateRecipe, type RecipeDraft } from './domain';
import type { Nutrition } from './food-log';
import {
  estimateMetadata,
  estimateNutrition,
  type MetadataEstimate,
} from './recipe-estimation';

/** What the estimates depend on: the raw amounts and the yield they are for. */
export function ingredientSignature(draft: RecipeDraft): string {
  return JSON.stringify([
    draft.basePortions,
    draft.ingredients.map(({ name, quantity, unit }) => [
      name.trim(),
      quantity,
      unit,
    ]),
  ]);
}

export function RecipeEstimation({
  draft,
  baseline,
  hasNutrition,
  available,
  onNutrition,
  onMetadata,
}: {
  draft: RecipeDraft;
  /** The ingredient signature the retained nutrition was entered against. */
  baseline: string;
  hasNutrition: boolean;
  available: boolean;
  onNutrition: (nutrition: Nutrition) => void;
  onMetadata: (metadata: MetadataEstimate) => void;
}) {
  const [connection, setConnection] = useState<AiStatus | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'nutrition' | 'metadata' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canceled = useRef(false);
  useEffect(
    () => () => {
      canceled.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!available) return;
    let active = true;
    void (async () => {
      try {
        const status = await aiStatus();
        if (!active) return;
        setConnection(status);
        if (status.state !== 'connected') return;
        const [listed, preferences] = await Promise.all([
          aiModels(),
          loadAiPreferences(),
        ]);
        if (!active) return;
        setModels(listed);
        setModel(
          listed.find((entry) => entry.slug === preferences.recipeModel)
            ?.slug ??
            listed[0]?.slug ??
            '',
        );
      } catch {
        // Estimation is optional: without it, values are entered manually.
      }
    })();
    return () => {
      active = false;
    };
  }, [available]);

  const ready = connection?.state === 'connected' && model !== '';
  const ingredientsChanged = ingredientSignature(draft) !== baseline;

  async function run(kind: 'nutrition' | 'metadata') {
    if (!ready || busy) return;
    const { recipe } = validateRecipe(draft);
    setError('');
    setNotice('');
    if (!recipe) {
      setError(
        'Complete the recipe name, base portions, ingredient names and quantities, and steps before asking for an estimate.',
      );
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'nutrition') {
        const nutrition = await estimateNutrition(model, recipe);
        if (canceled.current) return;
        onNutrition(nutrition);
        setNotice(
          'Nutrition estimated by ChatGPT. It is not measured: review and edit the values, then save the recipe to keep them.',
        );
      } else {
        const metadata = await estimateMetadata(model, recipe);
        if (canceled.current) return;
        onMetadata(metadata);
        setNotice(
          'Difficulty and time suggested by ChatGPT. They are estimates, not measured timings: review and edit them, then save the recipe to keep them.',
        );
      }
    } catch (failure) {
      if (canceled.current) return;
      setError(
        failure instanceof Error
          ? failure.message
          : 'The estimate could not be completed. Try again.',
      );
    } finally {
      if (!canceled.current) setBusy(null);
    }
  }

  function choose(slug: string) {
    setModel(slug);
    void saveRecipeModel(slug).catch(() => undefined);
  }

  return (
    <section className="panel" aria-labelledby="recipe-ai-heading">
      <div className="section-heading">
        <span className="section-number">05</span>
        <h2 id="recipe-ai-heading">AI assistance</h2>
      </div>
      <p className="section-note">
        Optional. ChatGPT can estimate whole-recipe nutrition from the raw
        ingredient amounts above, and suggest difficulty and time. You can
        always enter or leave these values yourself.
      </p>
      {available && connection && connection.state !== 'connected' && (
        <p>
          Connect ChatGPT in <a href="#/settings">Settings</a> to use estimates.
          Manual and unknown values stay valid without it.
        </p>
      )}
      {!available && (
        <p>
          Sign in to your backend account to use estimates. Manual and unknown
          values stay valid without it.
        </p>
      )}
      {ready && hasNutrition && ingredientsChanged && (
        <p role="status" aria-label="Nutrition re-estimate offer">
          The ingredients changed. Your previous nutrition is kept; re-estimate
          it with AI if you want it to match.
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" aria-label="Estimate status">
          {notice}
        </p>
      )}
      {ready && (
        <div className="form-actions">
          {models.length > 1 && (
            <label>
              Estimation model
              <select
                value={model}
                onChange={(event) => choose(event.target.value)}
              >
                {models.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="button secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => void run('nutrition')}
          >
            {busy === 'nutrition'
              ? 'Estimating…'
              : hasNutrition
                ? 'Re-estimate nutrition with AI'
                : 'Estimate nutrition with AI'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => void run('metadata')}
          >
            {busy === 'metadata'
              ? 'Suggesting…'
              : 'Suggest difficulty and time with AI'}
          </button>
        </div>
      )}
    </section>
  );
}
