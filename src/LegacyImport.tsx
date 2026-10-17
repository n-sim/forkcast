import { useRef, useState } from 'react';
import { execute } from './core';

interface ImportReport {
  alreadyApplied: boolean;
  recipes: number;
  revisions: number;
  nutritionVersions: number;
  photos: number;
  ratings: number;
  plannedCookings: number;
  shoppingList: boolean;
  cookingSessions: number;
  foodLogEntries: number;
  aiPrompts: number;
  pendingChanges: number;
  personIdentityPreserved: boolean;
  signInRequired: boolean;
  notes: string[];
}

/**
 * The supported way to bring an old browser profile into the installed app.
 * The file is an explicit export (never credentials); importing validates all
 * of it, applies it atomically, and can be repeated without duplicating.
 */
export function LegacyImport() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  async function run(file: File) {
    setBusy(true);
    setError('');
    setReport(null);
    try {
      let transfer: unknown;
      try {
        transfer = JSON.parse(await file.text());
      } catch {
        throw new Error(
          'This file is not a Forkcast browser transfer. Export one from the old browser profile first.',
        );
      }
      setReport(await execute<ImportReport>('importLegacy', { transfer }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <section
      className="panel account-form"
      aria-labelledby="legacy-import-heading"
    >
      <h2 id="legacy-import-heading">Move data from your browser</h2>
      <p>
        If you used Forkcast in a web browser before, export your data there
        with the browser data transfer page, then choose the file here. Your
        browser keeps its copy until you decide to delete it. Importing never
        copies sign-in sessions or ChatGPT credentials, and you can run it again
        safely.
      </p>
      <label>
        Browser transfer file
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(file);
          }}
        />
      </label>
      {busy && <p role="status">Importing…</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {report && (
        <div role="status" aria-label="Browser data import">
          <p>
            {report.alreadyApplied
              ? 'This transfer was already imported. Nothing changed.'
              : `Imported ${report.recipes} recipes, ${report.ratings} ratings, ${report.plannedCookings} planned cookings, ${report.cookingSessions} cooking sessions, and ${report.foodLogEntries} food-log entries.`}
          </p>
          {report.signInRequired && (
            <p>
              This browser was linked to a household. Its pending changes are
              kept; sign in again under Backend &amp; accounts to deliver them.
            </p>
          )}
          {report.notes.map((note) => (
            <p key={note} className="section-note">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
