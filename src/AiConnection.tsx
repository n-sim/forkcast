import { useEffect, useState, type FormEvent } from 'react';
import {
  companionKey,
  companionRequest,
  companionStatus,
  companionUrl,
  savedCompanion,
  type ChatGptStatus,
} from './ai-client';

export function AiConnection() {
  const [activeUrl, setActiveUrl] = useState(savedCompanion);
  const [url, setUrl] = useState(
    () => savedCompanion() ?? 'http://127.0.0.1:8788',
  );
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeUrl) return;
    let canceled = false;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const next = await companionStatus(activeUrl!);
        if (!canceled) {
          setStatus(next);
          setError('');
        }
      } catch (error) {
        if (!canceled) {
          setStatus(null);
          setError(
            error instanceof Error ? error.message : 'Companion unavailable.',
          );
        }
      } finally {
        checking = false;
      }
    }
    void check();
    const interval = window.setInterval(() => void check(), 2_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      canceled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [activeUrl]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const checkedUrl = companionUrl(url);
      const next = await companionStatus(checkedUrl);
      localStorage.setItem(companionKey, checkedUrl);
      setActiveUrl(checkedUrl);
      setUrl(checkedUrl);
      setStatus(next);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Check the companion URL.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function authorize() {
    // Open during the user's click so popup blockers do not swallow sign-in.
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setError(
        'Allow popups for Forkcast, then try Continue with ChatGPT again.',
      );
      return;
    }
    popup.opener = null;
    setBusy(true);
    setError('');
    try {
      const result = await companionRequest<{ authorizationUrl: string }>(
        activeUrl!,
        '/authorization',
        'POST',
      );
      const destination = new URL(result.authorizationUrl);
      if (
        !(
          destination.origin === 'https://auth.openai.com' ||
          (destination.protocol === 'http:' &&
            destination.hostname === '127.0.0.1')
        ) ||
        destination.pathname !== '/api/accounts/authorize'
      )
        throw new Error('The companion returned an invalid sign-in address.');
      popup.location.href = destination.href;
      setStatus({ state: 'authorizing', email: null, message: null });
    } catch (error) {
      popup.close();
      setError(
        error instanceof Error
          ? error.message
          : 'ChatGPT sign-in could not start.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      setStatus(
        await companionRequest<ChatGptStatus>(
          activeUrl!,
          '/connection',
          'DELETE',
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'ChatGPT sign-out could not complete.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="ChatGPT connection" className="panel account-form">
      <h2>ChatGPT</h2>
      <p>
        Connect your ChatGPT subscription through the optional native AI
        companion running on this device. No backend account is required.
      </p>
      <p>
        Your application data stays in this browser. The companion does not
        enable backups or synchronization.
      </p>
      <p role="status" aria-label="ChatGPT status">
        {status?.state === 'connected'
          ? `Connected as ${status.email ?? 'your ChatGPT account'}`
          : status?.state === 'authorizing'
            ? 'Waiting for ChatGPT authorization. Complete sign-in in the other window.'
            : status?.state === 'reconnect_required'
              ? 'ChatGPT needs reconnection'
              : error && !status
                ? 'Companion unavailable'
                : activeUrl && !status
                  ? 'Checking companion connection…'
                  : 'AI not configured'}
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {status?.message && (
        <p role="alert" className="error-banner">
          {status.message}
        </p>
      )}
      {status?.state === 'reconnect_required' && !status.message && (
        <p>Your ChatGPT session has expired. Connect again to continue.</p>
      )}
      {activeUrl && status && status.state !== 'connected' && (
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void authorize()}
        >
          {status.state === 'authorizing'
            ? 'Restart ChatGPT sign-in'
            : 'Continue with ChatGPT'}
        </button>
      )}
      {activeUrl && status?.state === 'connected' && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void signOut()}
        >
          Sign out of ChatGPT
        </button>
      )}
      {!activeUrl && (
        <p>
          Start the native AI companion on this device, then connect it here.
        </p>
      )}
      <form className="account-form" onSubmit={(event) => void connect(event)}>
        <label>
          Companion URL
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
        </label>
        <button className="button secondary" disabled={busy}>
          Connect companion
        </button>
      </form>
    </section>
  );
}
