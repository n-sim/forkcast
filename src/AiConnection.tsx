import { useCallback, useEffect, useState } from 'react';
import { isNative, openExternal, subscribeToTopics } from './core';
import {
  aiAuthorize,
  aiCancelAuthorization,
  aiCancelTransfer,
  aiRetryTransfer,
  aiSignOut,
  aiStatus,
  type AiStatus,
} from './ai-client';
import type { SyncStatus } from './household-client';

const summaries: Record<AiStatus['state'], string> = {
  unconfigured: 'ChatGPT is not connected',
  authorizing:
    'Waiting for ChatGPT authorization. Complete sign-in in your browser.',
  connected: 'Connected',
  denied: 'ChatGPT sign-in was not allowed',
  expired: 'ChatGPT sign-in expired',
  reconnect_required: 'ChatGPT needs reconnection',
  transferring: 'Finishing setup on your household server…',
  transfer_failed: 'Setup on your household server did not finish',
  unavailable: 'ChatGPT is unavailable right now',
};

export function AiConnection({ sync }: { sync?: SyncStatus | null }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await aiStatus());
      setError('');
    } catch (failure) {
      setStatus(null);
      setError(
        failure instanceof Error
          ? failure.message
          : 'The ChatGPT connection could not be read.',
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stop = subscribeToTopics(['ai', 'sync'], () => void refresh());
    const interval = window.setInterval(() => void refresh(), 3_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  async function act(work: () => Promise<AiStatus | void>) {
    setBusy(true);
    setError('');
    try {
      const next = await work();
      if (next) setStatus(next);
      else await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'That did not work.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const serverTarget = status?.target === 'server';
  const account = sync?.activeAccount;

  async function authorize() {
    // Sign-in happens in the person's own browser, not inside the app. A
    // joined app names the server and account it is granting access to.
    const selection =
      serverTarget && sync?.serverUrl && account
        ? { serverUrl: sync.serverUrl, accountId: account.id }
        : undefined;
    await act(async () => {
      await openExternal(await aiAuthorize(selection));
      setStatus(await aiStatus());
    });
  }

  const connected = status?.state === 'connected';
  const handoff =
    status?.state === 'transferring' || status?.state === 'transfer_failed';
  const authorizing = status?.state === 'authorizing';

  return (
    <section aria-label="ChatGPT connection" className="panel account-form">
      <h2>ChatGPT</h2>
      {serverTarget ? (
        <p>
          AI runs on your household server
          {status?.serverUrl ? ` (${status.serverUrl})` : ''}
          {status?.account ? ` for the account “${status.account}”` : ''}. Every
          device and browser signed in to that account uses this one connection.
          Your ChatGPT sign-in never leaves your device except to be handed to
          that server once you choose to.
        </p>
      ) : (
        <p>
          Connect your ChatGPT subscription to this device. No backend account
          or terminal setup is needed, and your session stays in protected
          storage on this device.
        </p>
      )}
      <p role="status" aria-label="ChatGPT status">
        {status
          ? connected
            ? `Connected as ${status.email ?? 'your ChatGPT account'}`
            : summaries[status.state]
          : error
            ? 'ChatGPT status unavailable'
            : 'Checking ChatGPT connection…'}
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {status?.message && (
        <p role={connected ? 'status' : 'alert'} className="error-banner">
          {status.message}
        </p>
      )}
      {status && !connected && !handoff && status.canAuthorize && isNative && (
        <button
          type="button"
          className="button primary"
          disabled={busy || (serverTarget && !account)}
          onClick={() => void authorize()}
        >
          {authorizing
            ? 'Restart ChatGPT sign-in'
            : serverTarget
              ? 'Set up ChatGPT on this server'
              : 'Continue with ChatGPT'}
        </button>
      )}
      {authorizing && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void act(aiCancelAuthorization)}
        >
          Cancel sign-in
        </button>
      )}
      {handoff && (
        <div className="form-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void act(aiRetryTransfer)}
          >
            Retry setup on server
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void act(aiCancelTransfer)}
          >
            Cancel setup
          </button>
        </div>
      )}
      {connected && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void act(aiSignOut)}
        >
          Sign out of ChatGPT
        </button>
      )}
      {status && !status.canAuthorize && !connected && (
        <p>
          ChatGPT connections are set up and reconnected in the installed
          Forkcast app, choosing this server and your account. Once connected,
          you can use it here.
        </p>
      )}
    </section>
  );
}
