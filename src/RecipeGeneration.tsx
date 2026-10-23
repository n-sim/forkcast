import { useEffect, useRef, useState, type FormEvent } from 'react';
import { generateRecipe } from './recipe-generation';
import { estimateNutrition } from './recipe-estimation';
import { loadRecipePrompt } from './ai-prompts';
import type { Recipe } from './domain';
import { AiModelNotice, useAiModel } from './use-ai-model';
import { DiscardChangesDialog, useShortcutHandler } from './shortcuts';

export function RecipeGeneration({
  onSave,
  promptsAvailable,
}: {
  onSave: (recipe: Recipe) => Promise<void>;
  promptsAvailable: boolean;
}) {
  const ai = useAiModel(promptsAvailable);
  const [description, setDescription] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const canceled = useRef(false);
  const backLink = useRef<HTMLAnchorElement>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Escape is easy to press by accident, so it asks before dropping a
  // description; a deliberate click on the link does not.
  useShortcutHandler(backLink, () => {
    if (description.trim()) setConfirmingDiscard(true);
    else backLink.current?.click();
  });
  useEffect(
    () => () => {
      canceled.current = true;
    },
    [],
  );
  const connected = ai.connection?.state === 'connected';
  const model = ai.model;
  const error = failure || ai.error;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !connected ||
      !ai.ready ||
      !promptsAvailable ||
      busy ||
      !description.trim()
    )
      return;
    setBusy(true);
    setFailure('');
    try {
      const preferences = await loadRecipePrompt();
      let recipe = await generateRecipe(model, description, preferences);
      if (canceled.current) return;
      // Generated recipes use the same estimation as edited ones, so their
      // nutrition is saved as an ordinary nutrition version. A failed
      // estimate leaves nutrition unknown and never blocks the recipe.
      try {
        recipe = {
          ...recipe,
          nutrition: await estimateNutrition(model, recipe),
        };
      } catch {
        /* Nutrition can be estimated or entered later. */
      }
      if (canceled.current) return;
      try {
        await onSave(recipe);
      } catch {
        throw new Error('The generated recipe could not be saved. Try again.');
      }
    } catch (error) {
      if (canceled.current) return;
      setFailure(
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
        <a
          ref={backLink}
          href="#/"
          className="button secondary"
          aria-keyshortcuts="Escape"
        >
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
      {promptsAvailable && ai.connection && !connected && (
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
        <button
          className="button primary"
          disabled={
            !connected ||
            !ai.ready ||
            !promptsAvailable ||
            !description.trim() ||
            busy
          }
        >
          {busy ? 'Generating…' : 'Generate recipe'}
        </button>
        <AiModelNotice choice={ai} />
        {busy && (
          <p role="status">Generating your recipe… Keep this page open.</p>
        )}
      </form>
      {confirmingDiscard && (
        <DiscardChangesDialog
          title="Discard this description?"
          discardLabel="Discard description"
          onKeep={() => setConfirmingDiscard(false)}
          onDiscard={() => {
            window.location.hash = '#/';
          }}
        >
          <p>
            {busy
              ? 'Your description is lost and the recipe being generated is not saved.'
              : 'Your description is not saved and is lost.'}
          </p>
        </DiscardChangesDialog>
      )}
    </article>
  );
}
