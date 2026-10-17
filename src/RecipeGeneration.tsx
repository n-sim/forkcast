import { useEffect, useRef, useState, type FormEvent } from 'react';
import { companionRequest, savedCompanion } from './ai-client';
import { generateRecipe } from './recipe-generation';
import { loadRecipePrompt } from './ai-prompts';
import type { Recipe } from './domain';

interface Model {
  slug: string;
  display_name: string;
}

export function RecipeGeneration({
  onSave,
  promptOwner,
}: {
  onSave: (recipe: Recipe) => Promise<void>;
  promptOwner: string | null;
}) {
  const [url] = useState(savedCompanion);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const execution = useRef<AbortController | null>(null);
  useEffect(() => () => execution.current?.abort(), []);
  useEffect(() => {
    if (!url) return;
    let canceled = false;
    void companionRequest<{ models: Model[] }>(url, '/models')
      .then((result) => {
        if (canceled) return;
        setModels(result.models);
        setModel(result.models[0]?.slug ?? '');
        if (!result.models.length)
          setError(
            'No ChatGPT models are available for this account. Check your connection in Settings.',
          );
      })
      .catch((error: unknown) => {
        if (!canceled)
          setError(
            error instanceof Error
              ? error.message
              : 'Could not load ChatGPT models.',
          );
      });
    return () => {
      canceled = true;
    };
  }, [url]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url || !model || !promptOwner || busy || !description.trim()) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    execution.current = controller;
    try {
      const preferences = loadRecipePrompt(promptOwner);
      const recipe = await generateRecipe(
        url,
        model,
        description,
        preferences,
        instructions,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      try {
        await onSave(recipe);
      } catch {
        throw new Error(
          'The generated recipe could not be saved on this device. Try again.',
        );
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(
        error instanceof Error
          ? error.message
          : 'Recipe generation failed. Try again.',
      );
    } finally {
      setBusy(false);
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
        each request. Add instructions below for this dish.
      </p>
      {!promptOwner && (
        <p>Sign in to your backend account to use your personal prompts.</p>
      )}
      {!url && (
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
          Instructions for this request
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={8000}
            disabled={busy}
          />
        </label>
        <label>
          ChatGPT model
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={busy || !models.length}
          >
            {models.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.display_name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={
            !url || !model || !promptOwner || !description.trim() || busy
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
