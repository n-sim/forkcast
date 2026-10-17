import { useEffect, useState, type FormEvent } from 'react';
import { loadRecipePrompt, saveRecipePrompt } from './ai-prompts';

export function AiPrompts({ enabled }: { enabled: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadRecipePrompt()
      .then((stored) => {
        if (active) {
          setPrompt(stored);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active)
          setError('Your prompt defaults could not be read on this device.');
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!enabled) return;
    setError('');
    setMessage('');
    try {
      await saveRecipePrompt(prompt);
      setMessage(
        'Saved. Future recipe requests will use these defaults. They belong to your personal account and never leave it.',
      );
    } catch {
      setError(
        'Your prompt defaults could not be saved. Keep this page open and try again.',
      );
    }
  }

  return (
    <section className="panel account-form" aria-label="Personal AI prompts">
      <h2>Personal AI prompts</h2>
      <p>
        Set your preferences for recipe generation. They belong to your personal
        account. Prompt synchronization will be available later.
      </p>
      {!enabled && (
        <p>Sign in to your backend account to manage your personal prompts.</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <form className="account-form" onSubmit={(event) => void save(event)}>
        <label>
          Recipe generation system prompt
          <textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setMessage('');
            }}
            maxLength={8000}
            disabled={!enabled || !loaded}
          />
        </label>
        <button className="button secondary" disabled={!enabled || !loaded}>
          Save prompt defaults
        </button>
        <p role="status">{message}</p>
      </form>
    </section>
  );
}
