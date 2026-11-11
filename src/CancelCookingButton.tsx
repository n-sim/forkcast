import { useRef, useState } from 'react';

// The "Cancel cooking" button and its confirmation dialog, shared by the
// cooking view and the suspended cooking bar so both end a session the same way.
export function CancelCookingButton({
  recipeName,
  disabled = false,
  onCancel,
}: {
  recipeName: string;
  disabled?: boolean;
  onCancel: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await onCancel();
    } catch (error) {
      setError(
        typeof error === 'string'
          ? error
          : 'Cooking progress could not be saved. Keep this view open and try again.',
      );
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  return (
    <>
      <button
        className="button secondary"
        disabled={disabled || saving}
        onClick={() => {
          setError('');
          dialog.current?.showModal();
        }}
      >
        Cancel cooking
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="cancel-cooking-title"
        aria-describedby="cancel-cooking-description"
        className="cancel-cooking-dialog"
        onCancel={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <h2 id="cancel-cooking-title">Cancel cooking?</h2>
        <p id="cancel-cooking-description">
          End the cooking session for <strong>{recipeName}</strong>? It will no
          longer be available to resume, and the recipe will not be marked
          cooked.
        </p>
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
            onClick={() => dialog.current?.close()}
          >
            Keep cooking
          </button>
          <button
            className="button primary"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void confirm()}
          >
            Cancel cooking
          </button>
        </div>
      </dialog>
    </>
  );
}
