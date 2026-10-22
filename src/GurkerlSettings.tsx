import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { openExternal, subscribeToTopics } from './core';
import { loadAiPreferences } from './ai-client';
import {
  saveCartPrompt,
  supermarketAuthorize,
  supermarketCancelAuthorization,
  supermarketSignOut,
  supermarketStatus,
  type SupermarketStatus,
} from './supermarket-client';

const summaries: Record<SupermarketStatus['state'], string> = {
  unconfigured: 'Gurkerl is not connected',
  authorizing:
    'Waiting for Gurkerl authorization. Complete sign-in in your browser.',
  connected: 'Connected to Gurkerl',
  denied: 'Gurkerl sign-in was not allowed',
  expired: 'Gurkerl sign-in expired',
  reconnect_required: 'Gurkerl needs reconnection',
};

/** The Gurkerl connection on this device and the product selection prompt. */
export function GurkerlSettings({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<SupermarketStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await supermarketStatus());
    } catch (failure) {
      setStatus(null);
      setError(
        failure instanceof Error
          ? failure.message
          : 'The Gurkerl connection could not be read.',
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const stop = subscribeToTopics(['supermarket'], () => void refresh());
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      stop();
      window.clearInterval(interval);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadAiPreferences()
      .then((stored) => {
        if (active) {
          setPrompt(stored.cartPrompt);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active)
          setError('Your product selection prompt could not be read.');
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  async function act(work: () => Promise<SupermarketStatus | void>) {
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

  async function savePrompt(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await saveCartPrompt(prompt);
      setMessage(
        'Saved. Future Gurkerl cart handoffs will choose products this way.',
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Your product selection prompt could not be saved.',
      );
    }
  }

  const connected = status?.state === 'connected';
  const authorizing = status?.state === 'authorizing';

  return (
    <section aria-label="Gurkerl connection" className="panel account-form">
      <h2>Gurkerl</h2>
      <p>
        Fill your Gurkerl cart from a reviewed shopping list. Forkcast never
        checks out or places an order; you finish shopping in Gurkerl. Your
        Gurkerl sign-in stays in protected storage on this device and is never
        shared with your household.
      </p>
      {!enabled && <p>Sign in to your household account to manage Gurkerl.</p>}
      {enabled && (
        <p role="status" aria-label="Gurkerl status">
          {status
            ? status.canConnect
              ? summaries[status.state]
              : 'Gurkerl carts are filled from the installed Forkcast app.'
            : error
              ? 'Gurkerl status unavailable'
              : 'Checking Gurkerl connection…'}
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {status?.message && !connected && (
        <p role="alert" className="error-banner">
          {status.message}
        </p>
      )}
      {status?.canConnect && !connected && (
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await openExternal(await supermarketAuthorize());
              setStatus(await supermarketStatus());
            })
          }
        >
          {authorizing ? 'Restart Gurkerl sign-in' : 'Connect Gurkerl'}
        </button>
      )}
      {authorizing && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void act(supermarketCancelAuthorization)}
        >
          Cancel Gurkerl sign-in
        </button>
      )}
      {connected && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void act(supermarketSignOut)}
        >
          Disconnect Gurkerl
        </button>
      )}
      <form
        className="account-form"
        onSubmit={(event) => void savePrompt(event)}
      >
        <label>
          Product selection prompt
          <textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setMessage('');
            }}
            maxLength={8000}
            disabled={!enabled || !loaded}
          />
        </label>
        <p className="section-note">
          For example, prefer the cheapest products, products you bought before,
          or organic products. It belongs to your personal account.
        </p>
        <button className="button secondary" disabled={!enabled || !loaded}>
          Save product selection prompt
        </button>
        <p role="status" aria-label="Product selection prompt status">
          {message}
        </p>
      </form>
    </section>
  );
}
