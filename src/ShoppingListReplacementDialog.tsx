import { useEffect, useRef } from 'react';

export function ShoppingListReplacementDialog({
  startDate,
  endDate,
  saving,
  error,
  onKeep,
  onReplace,
}: {
  startDate: string;
  endDate: string;
  saving: boolean;
  error: string;
  onKeep: () => void;
  onReplace: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shopping-replacement-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onKeep();
      }}
    >
      <h2 id="shopping-replacement-title">Replace shopping list?</h2>
      <p>
        Generate requirements for {startDate} through {endDate}? This replaces
        the current generated items, including quantity edits and removals.
      </p>
      <p>Manual shopping items and their quantities will be kept.</p>
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
          Keep current list
        </button>
        <button
          className="button primary"
          disabled={saving}
          onClick={() => void onReplace()}
        >
          {saving ? 'Replacing…' : 'Replace shopping list'}
        </button>
      </div>
    </dialog>
  );
}
