import { useEffect, useRef, useState } from 'react';
import { progressSummary, type CookingSession } from './cooking';

export function CookingConflictDialog({
  sessions,
  onKeep,
  onReplace,
}: {
  sessions: CookingSession[];
  onKeep: () => void;
  onReplace: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function replace() {
    setSaving(true);
    setError('');
    try {
      await onReplace();
    } catch {
      setError(
        'Your cooking session could not be changed. Nothing was canceled. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="cooking-conflict-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onKeep();
      }}
    >
      <h2 id="cooking-conflict-title">Cooking already in progress</h2>
      <p>
        You already have unfinished cooking. Keep it, or cancel the listed
        sessions before starting another.
      </p>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            {session.recipe.name} ·{' '}
            {session.conflict
              ? 'Changed on two devices'
              : progressSummary(session, session.recipe.steps.length)}
          </li>
        ))}
      </ul>
      <p>Canceling does not mark the recipe cooked.</p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          className="button secondary"
          autoFocus
          disabled={saving}
          onClick={onKeep}
        >
          {sessions.length === 1
            ? 'Keep current session'
            : 'Keep current sessions'}
        </button>
        <button
          className="button primary"
          disabled={saving}
          onClick={() => void replace()}
        >
          {sessions.length === 1
            ? 'Cancel current and start cooking'
            : 'Cancel all and start cooking'}
        </button>
      </div>
    </dialog>
  );
}
