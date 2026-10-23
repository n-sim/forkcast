import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FieldError } from './domain';
import {
  localDateTime,
  nutrients,
  validateManualFoodLogEntry,
  type ManualFoodLogEntry,
} from './food-log';
import { estimateFood, prepareEstimationPhoto } from './food-estimation';
import { AiModelNotice, useAiModel } from './use-ai-model';

export function ManualFoodLogForm({
  date,
  aiAvailable = true,
  onSave,
  onCancel,
}: {
  date: string;
  aiAvailable?: boolean;
  onSave: (entry: ManualFoodLogEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ManualFoodLogEntry>(() => ({
    id: crypto.randomUUID(),
    description: '',
    consumedAt: date + localDateTime().slice(10),
    nutrition: {
      calories: null,
      protein: null,
      fat: null,
      carbohydrates: null,
    },
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const ai = useAiModel(aiAvailable);
  // The estimation photo is held only here, for this form, and never saved.
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string>();
  const [estimating, setEstimating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [estimateError, setEstimateError] = useState('');
  const [estimateNotice, setEstimateNotice] = useState('');
  const closed = useRef(false);
  useEffect(
    () => () => {
      closed.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!photo) return setPhotoUrl(undefined);
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function choosePhoto(file: File) {
    setEstimateError('');
    try {
      setPhoto(await prepareEstimationPhoto(file));
    } catch (failure) {
      setEstimateError(
        failure instanceof Error ? failure.message : 'Choose another photo.',
      );
    }
  }

  function requestEstimate() {
    setEstimateError('');
    setEstimateNotice('');
    if (!draft.description.trim() && !photo) {
      setEstimateError(
        'Describe the food or add a photo to estimate its nutrition.',
      );
      return;
    }
    if (Object.values(draft.nutrition).some((value) => value !== null))
      setConfirming(true);
    else void estimate();
  }

  async function estimate() {
    if (!ai.ready || estimating) return;
    setEstimating(true);
    try {
      const result = await estimateFood(ai.model, draft.description, photo);
      if (closed.current) return;
      setDraft((current) => ({
        ...current,
        description: result.description,
        nutrition: result.nutrition,
      }));
      setErrors([]);
      setEstimateNotice(
        'Description and nutrition estimated by ChatGPT. They are not measured: review and edit them, then save the entry.',
      );
    } catch (failure) {
      if (closed.current) return;
      setEstimateError(
        failure instanceof Error
          ? failure.message
          : 'The estimate could not be completed. Try again, or enter nutrition manually.',
      );
    } finally {
      if (!closed.current) setEstimating(false);
    }
  }

  function fieldStatus(path: string) {
    return {
      id: `food-${path}`,
      'aria-invalid': errors.some((error) => error.path === path),
      'aria-describedby': errors.some((error) => error.path === path)
        ? `food-error-${path}`
        : undefined,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setErrors([]);
    try {
      const { entry, errors } = validateManualFoodLogEntry(draft);
      // Number inputs expose incomplete text (such as "1e") as an empty value.
      // Check the browser's input state before treating a blank as unknown.
      for (const { key, label } of nutrients) {
        const input = event.currentTarget.elements.namedItem(
          `nutrition.${key}`,
        );
        if (input instanceof HTMLInputElement && input.validity.badInput) {
          errors.push({
            path: `nutrition.${key}`,
            message: `Enter a valid number for ${label}, or clear it to leave it unknown.`,
          });
        }
      }
      if (!entry || errors.length > 0) {
        setErrors(errors);
        requestAnimationFrame(() => summary.current?.focus());
        return;
      }
      setSaving(true);
      await onSave(entry);
    } catch {
      setError(
        'Your entry could not be saved on this device. Keep this form open and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="manual-entry-heading">
      <h2 id="manual-entry-heading">Manual food-log entry</h2>
      <p className="section-note" id="manual-nutrition-help">
        Describe the food and amount you ate. Enter nutrition for that amount;
        leave any value blank if unknown. Zero means a known zero.
      </p>
      <form onSubmit={submit} noValidate>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {errors.length > 0 && (
          <div
            role="alert"
            className="error-banner"
            ref={summary}
            tabIndex={-1}
          >
            <strong>Check your entry</strong>
            <ul>
              {errors.map((error) => (
                <li key={error.path} id={`food-error-${error.path}`}>
                  <button
                    type="button"
                    className="error-link"
                    onClick={() =>
                      document.getElementById(`food-${error.path}`)?.focus()
                    }
                  >
                    {error.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset disabled={saving || estimating} className="food-entry-fields">
          <label className="name-field">
            Food description
            <input
              {...fieldStatus('description')}
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <label className="name-field">
            Consumed at
            <input
              {...fieldStatus('consumedAt')}
              type="datetime-local"
              step="60"
              value={draft.consumedAt}
              onChange={(event) =>
                setDraft({ ...draft, consumedAt: event.target.value })
              }
            />
          </label>
          <section
            className="food-estimate"
            aria-labelledby="food-estimate-heading"
          >
            <h3 id="food-estimate-heading">Estimate with AI</h3>
            {!aiAvailable && (
              <p className="section-note">
                Sign in to your backend account to estimate nutrition with AI.
                You can always enter nutrition manually.
              </p>
            )}
            {aiAvailable &&
              ai.loaded &&
              ai.connection?.state !== 'connected' && (
                <p className="section-note">
                  Connect ChatGPT in <a href="#/settings">Settings</a> to
                  estimate nutrition from a description or photo. You can always
                  enter nutrition manually.
                </p>
              )}
            {ai.connection?.state === 'connected' && (
              <>
                <p className="section-note" id="food-photo-help">
                  ChatGPT estimates from the food description, a photo, or both.
                  The photo is used only for this estimate and is never saved.
                </p>
                {ai.error && !ai.ready && (
                  <p role="alert" className="error-banner">
                    {ai.error}
                  </p>
                )}
                <AiModelNotice choice={ai} />
                <label htmlFor="food-photo">Food photo</label>
                <input
                  id="food-photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-describedby="food-photo-help"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void choosePhoto(file);
                  }}
                />
                {photoUrl && (
                  <div className="food-photo">
                    <img src={photoUrl} alt="Food photo for this estimate" />
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => setPhoto(null)}
                    >
                      Remove photo
                    </button>
                  </div>
                )}
                {estimateError && (
                  <p role="alert" className="error-banner">
                    {estimateError}
                  </p>
                )}
                {estimateNotice && (
                  <p role="status" aria-label="Food estimate status">
                    {estimateNotice}
                  </p>
                )}
                <button
                  className="button secondary"
                  type="button"
                  disabled={!ai.ready}
                  onClick={requestEstimate}
                >
                  {estimating ? 'Estimating…' : 'Estimate nutrition'}
                </button>
              </>
            )}
          </section>
          <div className="metadata-fields">
            {nutrients.map(({ key, label, unit }) => (
              <label key={key}>
                {label} ({unit})
                <input
                  {...fieldStatus(`nutrition.${key}`)}
                  name={`nutrition.${key}`}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Unknown"
                  aria-describedby={
                    fieldStatus(`nutrition.${key}`)['aria-describedby'] ??
                    'manual-nutrition-help'
                  }
                  value={draft.nutrition[key] ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      nutrition: {
                        ...draft.nutrition,
                        [key]:
                          event.target.value === ''
                            ? null
                            : Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button className="button primary" type="submit">
              {saving ? 'Saving…' : 'Save entry'}
            </button>
            <button
              className="button secondary"
              type="button"
              aria-keyshortcuts="Escape"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
      {confirming && (
        <ReplaceDialog
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void estimate();
          }}
        />
      )}
    </section>
  );
}

function ReplaceDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
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
      aria-labelledby="food-estimate-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="food-estimate-confirm-title">Replace nutrition values?</h2>
      <p>
        This entry already has nutrition values. The AI estimate replaces the
        description and every nutrition value in this form. Nothing is logged
        until you save the entry.
      </p>
      <div className="form-actions">
        <button
          className="button secondary"
          type="button"
          autoFocus
          onClick={onCancel}
        >
          Keep my values
        </button>
        <button className="button primary" type="button" onClick={onConfirm}>
          Replace with AI estimate
        </button>
      </div>
    </dialog>
  );
}
