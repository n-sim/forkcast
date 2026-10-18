import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  aiModels,
  aiStatus,
  loadAiPreferences,
  saveRecipeModel,
  type AiModel,
  type AiStatus,
} from './ai-client';
import { generateRecipe } from './recipe-generation';
import { loadRecipePrompt } from './ai-prompts';
import type { Recipe } from './domain';

export function RecipeGeneration({
  onSave,
  promptsAvailable,
}: {
  onSave: (recipe: Recipe) => Promise<void>;
  promptsAvailable: boolean;
}) {
  const [connection, setConnection] = useState<AiStatus | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canceled = useRef(false);
  useEffect(
    () => () => {
      canceled.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!promptsAvailable) return;
    let active = true;
    void (async () => {
      try {
        const status = await aiStatus();
        if (!active) return;
        setConnection(status);
        if (status.state !== 'connected') {
          setError(status.message ?? '');
          return;
        }
        const [listed, preferences] = await Promise.all([
          aiModels(),
          loadAiPreferences(),
        ]);
        if (!active) return;
        setModels(listed);
        // The model last chosen follows the person across devices.
        setModel(
          listed.find((entry) => entry.slug === preferences.recipeModel)
            ?.slug ??
            listed[0]?.slug ??
            '',
        );
        if (!listed.length)
          setError(
            'No ChatGPT models are available for this account. Check your connection in Settings.',
          );
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not load ChatGPT models.',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [promptsAvailable]);

  const connected = connection?.state === 'connected';

  function choose(slug: string) {
    setModel(slug);
    void saveRecipeModel(slug).catch(() => undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !connected ||
      !model ||
      !promptsAvailable ||
      busy ||
      !description.trim()
    )
      return;
    setBusy(true);
    setError('');
    try {
      const preferences = await loadRecipePrompt();
      const recipe = await generateRecipe(model, description, preferences);
      if (canceled.current) return;
      try {
        await onSave(recipe);
      } catch {
        throw new Error('The generated recipe could not be saved. Try again.');
      }
    } catch (error) {
      if (canceled.current) return;
      setError(
        error instanceof Error
          ? error.message
          : 'Recipe generation failed. Try again.',
      );
    } finally {
      if (!canceled.current) setBusy(false);
    }
  }

  return (
    <article>
      <div className="page-heading">
        <h1>Generate recipe</h1>
        <a href="#/" className="button secondary">
          Back to collection
        </a>
      </div>
      <p>
        Describe a dish. A successful recipe is saved automatically and opened
        for viewing and editing.
      </p>
      <p>
        Your saved <a href="#/settings">personal prompt defaults</a> apply to
        each request. Include any instructions for this dish in its description.
      </p>
      {!promptsAvailable && (
        <p>Sign in to your backend account to use your personal prompts.</p>
      )}
      {promptsAvailable && connection && !connected && (
        <p>
          Connect ChatGPT in <a href="#/settings">Settings</a> to generate
          recipes. You can also{' '}
          <a href="#/recipes/new">create a recipe manually</a>.
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error} <a href="#/settings">ChatGPT settings</a>
        </p>
      )}
      <form
        className="panel account-form"
        onSubmit={(event) => void submit(event)}
      >
        <label>
          Describe your dish
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required
            maxLength={8000}
            disabled={busy}
          />
        </label>
        <label>
          ChatGPT model
          <select
            value={model}
            onChange={(event) => choose(event.target.value)}
            disabled={busy || !models.length}
          >
            {models.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={
            !connected ||
            !model ||
            !promptsAvailable ||
            !description.trim() ||
            busy
          }
        >
          {busy ? 'Generating…' : 'Generate recipe'}
        </button>
        {busy && (
          <p role="status">Generating your recipe… Keep this page open.</p>
        )}
      </form>
    </article>
  );
}
