import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  canShareFiles,
  saveGeneratedFile,
  shareGeneratedFile,
  type GeneratedFile,
} from './share';

export function ShareIcon() {
  return (
    <svg
      className="button-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

/** What the status line says, with the subject ("Recipe PDF") and any reassurance added by the caller. */
export interface PdfShareMessages {
  /** Such as "Recipe PDF". */
  subject: string;
  /** Appended to every outcome, such as "Your shopping list is still available." */
  note?: string;
  /** Appended to errors, such as "Your shopping list has been kept." */
  errorNote?: string;
}

/**
 * A Share button for a generated PDF. It offers the platform's share sheet
 * (Web Share in a browser, the share sheet on Android) and saving the PDF as
 * before. Where sharing is unavailable and there are no options to choose,
 * Share saves straight away.
 */
export function PdfShare({
  label,
  heading,
  description,
  statusLabel,
  messages,
  disabled,
  options,
  optionsKey = '',
  create,
}: {
  /** Accessible name of the Share button, such as "Share recipe". */
  label: string;
  heading: string;
  description: ReactNode;
  statusLabel: string;
  messages: PdfShareMessages;
  disabled: boolean;
  /** Choices that change the PDF, shown in the dialog. */
  options?: (busy: boolean) => ReactNode;
  /** Changes whenever `options` would produce a different PDF. */
  optionsKey?: string;
  create: () => Promise<GeneratedFile>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [shareable, setShareable] = useState(false);
  const [busy, setBusy] = useState<'share' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // A PDF prepared for sharing that the browser wants a fresh tap to send.
  const prepared = useRef<{ key: string; file: GeneratedFile } | null>(null);

  useEffect(() => {
    let current = true;
    void canShareFiles().then((available) => {
      if (current) setShareable(available);
    });
    return () => {
      current = false;
    };
  }, []);

  function say(text: string, note = messages.note) {
    setMessage(note ? `${text} ${note}` : text);
  }

  function fail(text: string) {
    setError(messages.errorNote ? `${text} ${messages.errorNote}` : text);
    setMessage('');
  }

  async function save() {
    setBusy('save');
    setError('');
    say('Preparing PDF…', undefined);
    try {
      const saved = await saveGeneratedFile(await create());
      say(saved ? `${messages.subject} saved.` : 'PDF saving cancelled.');
      dialog.current?.close();
    } catch {
      fail('The PDF could not be saved. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    setBusy('share');
    setError('');
    const kept =
      prepared.current?.key === optionsKey ? prepared.current.file : null;
    prepared.current = null;
    setReady(false);
    if (!kept) say('Preparing PDF…', undefined);
    try {
      const file = kept ?? (await create());
      const outcome = await shareGeneratedFile(file);
      if (outcome === 'needs-gesture') {
        if (kept) {
          fail('Sharing is not allowed here. Use Save PDF instead.');
          return;
        }
        prepared.current = { key: optionsKey, file };
        setReady(true);
        setMessage('');
        return;
      }
      say(
        {
          shared: `${messages.subject} shared.`,
          opened: `Choose an app to share the ${messages.subject}.`,
          cancelled: 'Sharing cancelled.',
        }[outcome],
      );
      dialog.current?.close();
    } catch {
      fail('The PDF could not be shared. Try again.');
    } finally {
      setBusy(null);
    }
  }

  function open() {
    setError('');
    setMessage('');
    prepared.current = null;
    setReady(false);
    if (!options && !shareable) void save();
    else {
      dialog.current?.showModal();
      setDialogOpen(true);
    }
  }

  const working = busy !== null;
  const readyToShare = ready && prepared.current?.key === optionsKey;
  return (
    <>
      <button
        type="button"
        className="button secondary"
        aria-label={label}
        disabled={disabled || working}
        onClick={open}
      >
        <ShareIcon />
        Share
      </button>
      <p className="share-status" role="status" aria-label={statusLabel}>
        {message}
      </p>
      {error && !dialogOpen && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="cancel-cooking-dialog"
        onCancel={(event) => {
          if (working) event.preventDefault();
        }}
        onClose={() => {
          prepared.current = null;
          setReady(false);
          setDialogOpen(false);
        }}
      >
        <h2 id={`${id}-title`}>{heading}</h2>
        <p id={`${id}-description`}>{description}</p>
        {options?.(working)}
        {readyToShare && (
          <p role="status">
            The PDF is ready. Select Share again to choose an app.
          </p>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={working}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button ${shareable ? 'secondary' : 'primary'}`}
            autoFocus={!shareable}
            disabled={working}
            aria-busy={busy === 'save'}
            onClick={() => void save()}
          >
            {busy === 'save' ? 'Saving…' : 'Save PDF'}
          </button>
          {shareable && (
            <button
              type="button"
              className="button primary"
              autoFocus
              disabled={working}
              aria-busy={busy === 'share'}
              onClick={() => void share()}
            >
              {busy === 'share'
                ? 'Sharing…'
                : readyToShare
                  ? 'Share now…'
                  : 'Share…'}
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}
