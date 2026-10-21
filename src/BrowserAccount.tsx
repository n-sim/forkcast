import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  CoreError,
  browserToken,
  serverRequest,
  setBrowserToken,
  takeSessionEnded,
} from './core';
import { HouseholdAccounts } from './Household';

export interface BrowserSession {
  account: {
    id: string;
    username: string;
    role: 'administrator' | 'member';
  };
  household: { id: string; name: string };
}

type State =
  | { phase: 'checking' }
  | { phase: 'signed-out'; setupRequired: boolean; message: string }
  | { phase: 'signed-in'; session: BrowserSession }
  | { phase: 'unreachable'; message: string };

/**
 * A browser is an online client of its household server. It holds a bearer
 * token and nothing else: no records, no queued changes.
 */
export function useBrowserSession(enabled: boolean) {
  const [state, setState] = useState<State>({ phase: 'checking' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    async function check() {
      try {
        const token = browserToken();
        // A stored token's session is checked alongside the server's status
        // rather than after it.
        const [status, session] = await Promise.all([
          serverRequest<{ setupRequired: boolean }>(
            '/status',
            'GET',
            undefined,
            null,
          ),
          token ? serverRequest<BrowserSession>('/session') : null,
        ]);
        if (!session) {
          if (!canceled)
            setState({
              phase: 'signed-out',
              setupRequired: status.setupRequired,
              message: takeSessionEnded()
                ? 'Your session ended. Sign in again.'
                : '',
            });
          return;
        }
        if (!canceled) setState({ phase: 'signed-in', session });
      } catch (failure) {
        if (canceled) return;
        if (failure instanceof CoreError && failure.kind === 'unauthenticated')
          setState({
            phase: 'signed-out',
            setupRequired: false,
            message: 'Your session ended. Sign in again.',
          });
        else
          setState({
            phase: 'unreachable',
            message:
              failure instanceof Error ? failure.message : String(failure),
          });
      }
    }
    void check();
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener('forkcast-browser-session', changed);
    window.addEventListener('online', changed);
    return () => {
      canceled = true;
      window.removeEventListener('forkcast-browser-session', changed);
      window.removeEventListener('online', changed);
    };
  }, [enabled, revision]);
  const retry = useCallback(() => {
    setState({ phase: 'checking' });
    setRevision((value) => value + 1);
  }, []);
  return { state, retry };
}

export async function signOutOfBrowser() {
  try {
    await serverRequest('/session', 'DELETE');
  } catch (failure) {
    if (!(failure instanceof CoreError && failure.kind === 'unauthenticated'))
      throw failure;
  }
  setBrowserToken(null);
}

export function BrowserSignIn({
  setupRequired,
  message,
}: {
  setupRequired: boolean;
  message: string;
}) {
  const [householdName, setHouseholdName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(message);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const signedIn = await serverRequest<{ token: string }>(
        setupRequired ? '/setup' : '/login',
        'POST',
        {
          ...(setupRequired ? { householdName } : {}),
          username,
          password,
        },
        null,
      );
      setPassword('');
      setBrowserToken(signedIn.token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="startup-error browser-gate" id="main-content">
      <h1>{setupRequired ? 'Set up your household' : 'Sign in to Forkcast'}</h1>
      <p>
        This browser works with your household’s Forkcast server. Changes are
        saved on the server, so a connection is required. Install the desktop
        app to cook, plan, and log food offline.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <form className="account-form" onSubmit={(event) => void submit(event)}>
        {setupRequired && (
          <label>
            Household name
            <input
              value={householdName}
              maxLength={80}
              onChange={(event) => setHouseholdName(event.target.value)}
              required
            />
          </label>
        )}
        <label>
          Username
          <input
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={setupRequired ? 'new-password' : 'current-password'}
            value={password}
            maxLength={128}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="button primary" disabled={busy}>
          {setupRequired ? 'Create administrator' : 'Sign in'}
        </button>
      </form>
      <section aria-labelledby="old-browser-data">
        <h2 id="old-browser-data">Used Forkcast in this browser before?</h2>
        <p>
          Recipes you kept in this browser are still here and have not been
          touched. Open the{' '}
          <a href="./legacy-export.html">browser data transfer</a> to export
          them, then import the file in the Forkcast desktop app.
        </p>
      </section>
    </main>
  );
}

export function BrowserUnreachable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="startup-error" id="main-content">
      <h1>Forkcast can’t reach its server</h1>
      <p role="alert">{message}</p>
      <p>
        Nothing was changed. This browser needs a connection to your household
        server; the desktop app works offline.
      </p>
      <button className="button primary" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

export function BrowserAccountPanel({ session }: { session: BrowserSession }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await signOutOfBrowser();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }
  return (
    <section
      className="panel account-form"
      aria-labelledby="backend-accounts-heading"
    >
      <h2 id="backend-accounts-heading">Backend &amp; accounts</h2>
      <h3>{session.household.name}</h3>
      <p>
        Signed in as <strong>{session.account.username}</strong> (
        {session.account.role === 'administrator'
          ? 'Administrator'
          : 'Household member'}
        ). This browser works directly with your household server; nothing is
        stored here.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void signOut()}
      >
        Sign out
      </button>
      {session.account.role === 'administrator' && (
        <HouseholdAccounts enabled />
      )}
    </section>
  );
}
