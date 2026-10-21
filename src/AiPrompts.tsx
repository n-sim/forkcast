import { useEffect, useState, type FormEvent } from 'react';
import { saveRecipePrompt, savePlanPrompt } from './ai-prompts';
import { loadAiPreferences } from './ai-client';

export function AiPrompts({ enabled }: { enabled: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [planPrompt, setPlanPrompt] = useState('');
  const [savedPlanPrompt, setSavedPlanPrompt] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadAiPreferences()
      .then((stored) => {
        if (active) {
          setPrompt(stored.recipePrompt);
          setPlanPrompt(stored.planPrompt);
          setSavedPlanPrompt(stored.planPrompt);
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
      // An unchanged default is not another change to synchronize.
      if (planPrompt !== savedPlanPrompt) {
        await savePlanPrompt(planPrompt);
        setSavedPlanPrompt(planPrompt);
      }
      setMessage(
        'Saved on this device. Future recipe and cooking plan requests will use these defaults.',
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
        Set your preferences for recipe and cooking plan generation. They belong
        to your personal account and follow it to your other devices when you
        use a household server. Instructions for a single request go in that
        request, not here.
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
        <label>
          Cooking plan system prompt
          <textarea
            value={planPrompt}
            onChange={(event) => {
              setPlanPrompt(event.target.value);
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
