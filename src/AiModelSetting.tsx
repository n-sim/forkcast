import { useEffect, useState } from 'react';
import { saveRecipeModel } from './ai-client';
import { useAiModel } from './use-ai-model';

export function AiModelSetting({ enabled }: { enabled: boolean }) {
  const choice = useAiModel(enabled);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setSelected(choice.saved ?? '');
  }, [choice.saved]);
  const connected = choice.connection?.state === 'connected';
  // What is selected, not what was loaded, decides whether a model is gone.
  const missing =
    selected &&
    connected &&
    !choice.models.some((entry) => entry.slug === selected)
      ? selected
      : null;

  async function choose(slug: string) {
    setSelected(slug);
    setMessage('');
    setError('');
    try {
      await saveRecipeModel(slug || null);
      setMessage('Model saved. Generation and estimates will use it.');
    } catch {
      setError('Your model could not be saved. Try again.');
    }
  }

  return (
    <section className="panel account-form" aria-label="AI model">
      <h2>AI model</h2>
      <p>
        The ChatGPT model used to generate recipes and estimate nutrition,
        difficulty and time. It belongs to your personal account and follows it
        to your other devices when you use a household server.
      </p>
      {!enabled && (
        <p>Sign in to your backend account to choose your AI model.</p>
      )}
      {enabled && choice.loaded && !connected && (
        <p>Connect ChatGPT above to choose a model.</p>
      )}
      {missing && (
        <p
          className="nutrition-version-notice"
          role="status"
          aria-label="AI model unavailable"
        >
          Your saved model “{missing}” is no longer available through ChatGPT.
          Choose another model below; until then AI requests are paused.
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <label>
        Model
        <select
          value={selected}
          onChange={(event) => void choose(event.target.value)}
          disabled={!enabled || !connected || !choice.models.length}
        >
          <option value="">First available model</option>
          {choice.models.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.displayName}
            </option>
          ))}
          {missing && (
            <option value={missing} disabled>
              {missing} (no longer available)
            </option>
          )}
        </select>
      </label>
      <p role="status">{message}</p>
    </section>
  );
}
