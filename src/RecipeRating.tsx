import { useState, type FormEvent } from 'react';

export function PersonalRecipeRating({
  value,
  onSave,
}: {
  value?: number;
  onSave: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await onSave(draft === '' ? null : Number(draft));
      setMessage(draft === '' ? 'Your rating removed.' : 'Your rating saved.');
    } catch {
      setError('Your rating could not be saved on this device. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel rating-panel" aria-labelledby="rating-heading">
      <h2 id="rating-heading">Personal rating</h2>
      <p id="rating-help" className="section-note">
        Your assessment, from 1 to 5. Kept separately from the household’s
        difficulty and times.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="personal-rating">Your rating</label>
        <select
          id="personal-rating"
          value={draft}
          disabled={saving}
          aria-describedby="rating-help"
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage('');
          }}
        >
          <option value="">Not rated</option>
          {[1, 2, 3, 4, 5].map((score) => (
            <option key={score} value={score}>
              {score} / 5
            </option>
          ))}
        </select>
        <button type="submit" className="button secondary" disabled={saving}>
          {saving ? 'Saving…' : 'Save rating'}
        </button>
      </form>
      <p role="status" aria-label="Rating status">
        {message}
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </section>
  );
}
