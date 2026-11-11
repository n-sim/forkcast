import { useRef, useState } from 'react';
import type { DisplayUnits, Recipe } from './domain';

export function RecipePdfExport({
  recipe,
  portions,
  displayUnits,
  photo,
  rating,
  disabled,
}: {
  recipe: Recipe;
  portions: number;
  displayUnits: DisplayUnits;
  photo?: Blob;
  rating?: number;
  disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [includeAllocations, setIncludeAllocations] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function exportPdf() {
    setExporting(true);
    setError('');
    setMessage('Preparing PDF…');
    try {
      const { exportRecipePdf } = await import('./recipe-pdf');
      const saved = await exportRecipePdf({
        recipe,
        portions,
        displayUnits,
        photo,
        rating,
        includeAllocations,
      });
      setMessage(saved ? 'Recipe PDF exported.' : 'PDF export cancelled.');
      dialog.current?.close();
    } catch {
      setError('The PDF could not be exported. Try again.');
      setMessage('');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={disabled}
        onClick={() => {
          setError('');
          setMessage('');
          dialog.current?.showModal();
        }}
      >
        Export PDF
      </button>
      <p role="status" aria-label="Recipe PDF export status">
        {message}
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="export-recipe-pdf-title"
        aria-describedby="export-recipe-pdf-description"
        className="cancel-cooking-dialog"
        onCancel={(event) => {
          if (exporting) event.preventDefault();
        }}
      >
        <h2 id="export-recipe-pdf-title">Export recipe as PDF</h2>
        <p id="export-recipe-pdf-description">
          For {portions} {portions === 1 ? 'portion' : 'portions'}, in the units
          shown on the recipe page.
        </p>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={includeAllocations}
            disabled={exporting}
            onChange={(event) => setIncludeAllocations(event.target.checked)}
          />
          Include step allocations
        </label>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={exporting}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            autoFocus
            disabled={exporting}
            aria-busy={exporting}
            onClick={() => void exportPdf()}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </dialog>
    </>
  );
}
