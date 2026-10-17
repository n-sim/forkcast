import { useState, type FormEvent } from 'react';
import { loadRecipePrompt, saveRecipePrompt } from './ai-prompts';

export function AiPrompts({ owner }: { owner: string | null }) {
  const [initial] = useState(() => {
    try {
      return { prompt: owner ? loadRecipePrompt(owner) : '', error: '' };
    } catch {
      return {
        prompt: '',
        error: 'Your prompt defaults could not be read on this device.',
      };
    }
  });
  const [prompt, setPrompt] = useState(initial.prompt);
  const [error, setError] = useState(initial.error);
  const [message, setMessage] = useState('');

  function save(event: FormEvent) {
    event.preventDefault();
    if (!owner) return;
    setError('');
    setMessage('');
    try {
      saveRecipePrompt(owner, prompt);
      setMessage(
        'Saved on this device. Future recipe requests will use these defaults.',
      );
    } catch {
      setError(
        'Your prompt defaults could not be saved on this device. Keep this page open and try again.',
      );
    }
  }

  return (
    <section className="panel account-form" aria-label="Personal AI prompts">
      <h2>Personal AI prompts</h2>
      <p>
        Set your preferences for recipe generation. They stay on this device for
        your personal account. Prompt synchronization will be available later.
      </p>
      {!owner && (
        <p>Sign in to your backend account to manage your personal prompts.</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <form className="account-form" onSubmit={save}>
        <label>
          Recipe generation system prompt
          <textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setMessage('');
            }}
            maxLength={8000}
            disabled={!owner}
          />
        </label>
        <button className="button secondary" disabled={!owner}>
          Save prompt defaults
        </button>
        <p role="status">{message}</p>
      </form>
    </section>
  );
}
