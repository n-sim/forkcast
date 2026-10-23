import { useState, type FormEvent } from 'react';
import type { FoodLogEntry } from './food-log';

export interface FoodLogEntryChanges {
  consumedAt: string;
  portions?: number;
  description?: string;
}

/**
 * Corrects when an entry was eaten and its portions (recipe entries) or
 * description (manual entries). A recipe entry keeps its logged nutrition
 * version.
 */
export function FoodLogEntryEditor({
  entry,
  onSave,
  onCancel,
}: {
  entry: FoodLogEntry;
  onSave: (changes: FoodLogEntryChanges) => Promise<void>;
  onCancel: () => void;
}) {
  const recipeEntry = entry.recipeId !== null;
  const [consumedAt, setConsumedAt] = useState(entry.consumedAt);
  const [portions, setPortions] = useState(String(entry.portions ?? ''));
  const [description, setDescription] = useState(entry.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(portions);
    if (recipeEntry && !(amount > 0)) {
      setError('Portions eaten must be greater than zero.');
      return;
    }
    if (!recipeEntry && !description.trim()) {
      setError('Enter a food description.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(
        recipeEntry
          ? { consumedAt, portions: amount }
          : { consumedAt, description },
      );
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'This entry could not be changed. It keeps its logged values.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="food-log-entry-editor"
      aria-label={`Edit ${entry.description}`}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        Consumed at
        <input
          type="datetime-local"
          required
          value={consumedAt}
          onChange={(event) => setConsumedAt(event.target.value)}
        />
      </label>
      {recipeEntry ? (
        <label>
          Portions eaten
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            required
            value={portions}
            onChange={(event) => setPortions(event.target.value)}
          />
        </label>
      ) : (
        <label>
          Food description
          <input
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={saving}>
          Save changes
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={saving}
          aria-keyshortcuts="Escape"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
