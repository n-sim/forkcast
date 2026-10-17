import { useEffect, useState, type FormEvent } from 'react';
import {
  BackendError,
  backendRequest,
  backendUrl,
  loadBackendConfig,
  saveBackendConfig,
  type Account,
  type BackendConfig,
  type BackendSession,
} from './backend-client';

function HouseholdAccounts({ config }: { config: BackendConfig }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resetAccount, setResetAccount] = useState<Account | null>(null);
  const [replacementPassword, setReplacementPassword] = useState('');

  useEffect(() => {
    let canceled = false;
    void backendRequest<Account[]>(config, '/accounts')
      .then((accounts) => {
        if (!canceled) setAccounts(accounts);
      })
      .catch((error: Error) => {
        if (!canceled) setError(error.message);
      });
    return () => {
      canceled = true;
    };
  }, [config]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const account = await backendRequest<Account>(
        config,
        '/accounts',
        'POST',
        { username, password },
      );
      setPassword('');
      setUsername('');
      setAccounts((accounts) => [...accounts, account]);
      setMessage(
        `Account created for ${account.username}. Share the backend URL and credentials with them directly.`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function change(
    account: Account,
    body: { active: boolean } | { password: string },
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await backendRequest<Account>(
        config,
        `/accounts/${account.id}`,
        'PATCH',
        body,
      );
      setAccounts((accounts) =>
        accounts.map((item) => (item.id === updated.id ? updated : item)),
      );
      setResetAccount(null);
      setReplacementPassword('');
      setMessage(
        'password' in body
          ? `Password reset for ${account.username}. Their existing sessions have ended.`
          : `Account ${updated.active ? 'enabled' : 'disabled'} for ${account.username}.`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-form">
      <h3>Household accounts</h3>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {message && (
        <p role="status" aria-label="Account administration">
          {message}
        </p>
      )}
      <table aria-label="Household accounts">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id}>
              <td>{account.username}</td>
              <td>
                {account.role === 'administrator' ? 'Administrator' : 'Member'}
              </td>
              <td>{account.active ? 'Active' : 'Disabled'}</td>
              <td>
                {account.role === 'member' && (
                  <div className="account-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void change(account, { active: !account.active })
                      }
                    >
                      {account.active ? 'Disable account' : 'Enable account'}
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        setResetAccount(account);
                        setReplacementPassword('');
                      }}
                    >
                      Reset password
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {resetAccount && (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void change(resetAccount, { password: replacementPassword });
          }}
        >
          <h4>Reset password for {resetAccount.username}</h4>
          <label>
            Replacement password
            <input
              type="password"
              value={replacementPassword}
              autoComplete="new-password"
              maxLength={128}
              onChange={(event) => setReplacementPassword(event.target.value)}
              required
            />
          </label>
          <p>Resetting a password signs this person out on all devices.</p>
          <div className="account-actions">
            <button className="button primary" disabled={busy}>
              Save replacement password
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setResetAccount(null);
                setReplacementPassword('');
              }}
            >
              Cancel password reset
            </button>
          </div>
        </form>
      )}
      <form className="account-form" onSubmit={(event) => void create(event)}>
        <h4>Create a household account</h4>
        <p>
          No email or external identity provider is required. Household members
          use their own username and password.
        </p>
        <label>
          New username
          <input
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            maxLength={32}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            maxLength={128}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <small>
          Username: 3–32 letters, numbers, dots, underscores, or hyphens.
          Password: 12–128 characters.
        </small>
        <button className="button primary" disabled={busy}>
          Create household account
        </button>
      </form>
    </section>
  );
}

export function useBackendConnection() {
  const [config, setConfig] = useState(loadBackendConfig);
  const [session, setSession] = useState<BackendSession | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [checking, setChecking] = useState(Boolean(config));
  const [connectionError, setConnectionError] = useState('');
  const [revision, setRevision] = useState(0);

  function remember(next: BackendConfig | null) {
    saveBackendConfig(next);
    setChecking(Boolean(next));
    setConnectionError('');
    setSession(null);
    setConfig(next);
  }

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'forkcast-backend' || event.key === null) {
        const next = loadBackendConfig();
        setSession(null);
        setChecking(Boolean(next));
        setConnectionError('');
        setConfig(next);
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);

  useEffect(() => {
    if (!config) return;
    const recheck = () => setRevision((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    const interval = window.setInterval(recheck, 30_000);
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    window.addEventListener('offline', recheck);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', recheck);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [config]);

  useEffect(() => {
    let canceled = false;
    if (!config) return;
    const current = config;
    async function check() {
      try {
        const status = await backendRequest<{ setupRequired: boolean }>(
          current,
          '/status',
        );
        if (typeof status.setupRequired !== 'boolean')
          throw new BackendError('This URL is not a Forkcast backend.');
        const session = current.token
          ? await backendRequest<BackendSession>(current, '/session')
          : null;
        if (!canceled) {
          if (
            session &&
            (current.accountId !== session.account.id ||
              current.householdId !== session.household.id)
          ) {
            const next = {
              ...current,
              accountId: session.account.id,
              householdId: session.household.id,
            };
            saveBackendConfig(next);
            setConfig(next);
          }
          setSetupRequired(status.setupRequired);
          setSession(session);
          setConnectionError('');
        }
      } catch (error) {
        if (!canceled) {
          if (error instanceof BackendError && error.status === 401) {
            remember({ url: current.url });
            setConnectionError('Your session ended. Sign in again.');
          } else {
            setSession(null);
            setConnectionError(
              String(error instanceof Error ? error.message : error),
            );
          }
        }
      } finally {
        if (!canceled) setChecking(false);
      }
    }
    void check();
    return () => {
      canceled = true;
    };
  }, [config, revision]);

  return {
    config,
    session,
    setupRequired,
    checking,
    connectionError,
    label: !config
      ? 'Standalone'
      : checking
        ? 'Checking backend…'
        : session
          ? `${session.account.username} · ${session.account.role === 'administrator' ? 'Administrator' : 'Household member'}`
          : connectionError
            ? 'Backend unavailable'
            : 'Backend · signed out',
    refresh: () => {
      setChecking(Boolean(config));
      setRevision((value) => value + 1);
    },
    async connect(value: string) {
      const url = backendUrl(value);
      const status = await backendRequest<{ setupRequired: boolean }>(
        { url },
        '/status',
      );
      if (typeof status.setupRequired !== 'boolean')
        throw new BackendError('This URL is not a Forkcast backend.');
      remember({ url });
    },
    async authenticate(path: '/setup' | '/login', credentials: unknown) {
      if (!config) return;
      const signedIn = await backendRequest<BackendSession & { token: string }>(
        config,
        path,
        'POST',
        credentials,
      );
      remember({
        url: config.url,
        token: signedIn.token,
        accountId: signedIn.account.id,
        householdId: signedIn.household.id,
      });
    },
    async signOut() {
      if (!config) return;
      try {
        await backendRequest(config, '/session', 'DELETE');
      } catch (error) {
        if (!(error instanceof BackendError && error.status === 401))
          throw error;
      }
      remember({ url: config.url });
    },
    forget: () => remember(null),
  };
}

export function BackendAccounts({
  connection,
}: {
  connection: ReturnType<typeof useBackendConnection>;
}) {
  const [url, setUrl] = useState('http://127.0.0.1:8787');
  const [householdName, setHouseholdName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof BackendError && [0, 409].includes(error.status))
        connection.refresh();
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await connection.authenticate(
        connection.setupRequired ? '/setup' : '/login',
        {
          ...(connection.setupRequired ? { householdName } : {}),
          username,
          password,
        },
      );
      setPassword('');
    });
  }

  return (
    <section
      className="panel account-form"
      aria-labelledby="backend-accounts-heading"
    >
      <h2 id="backend-accounts-heading">Backend &amp; accounts</h2>
      <section>
        <h3>Standalone records stay on this device</h3>
        <p>
          Connecting an account keeps your local records. Enable recipe
          synchronization separately below to share recipes and photos and
          synchronize your own ratings, then review existing device planning to
          share the household meal plan and shopping list. Food logs and cooking
          sessions remain on this device.
        </p>
        <p>You can keep using standalone mode without an account.</p>
      </section>
      {(error || connection.connectionError) && (
        <p role="alert" className="error-banner">
          {error || connection.connectionError}
        </p>
      )}
      {!connection.config ? (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => connection.connect(url));
          }}
        >
          <h3>Connect a self-hosted instance</h3>
          <label>
            Backend URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </label>
          <button className="button primary" disabled={busy}>
            Connect backend
          </button>
        </form>
      ) : (
        <section className="account-form">
          <p>Backend: {connection.config.url}</p>
          {connection.checking ? (
            <p role="status">Checking connection…</p>
          ) : connection.session ? (
            <>
              <h3>{connection.session.household.name}</h3>
              <p>
                Signed in as{' '}
                <strong>{connection.session.account.username}</strong> (
                {connection.session.account.role === 'administrator'
                  ? 'Administrator'
                  : 'Household member'}
                ).
              </p>
              <p>
                Recipes, cooking history, the meal plan, and the shopping list
                belong to the household. Food logs, nutrition goals, ratings, AI
                settings, and cooking sessions belong to each person.
              </p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void run(connection.signOut)}
              >
                Sign out
              </button>
            </>
          ) : !connection.connectionError ? (
            <form className="account-form" onSubmit={submit}>
              <h3>
                {connection.setupRequired ? 'Set up your household' : 'Sign in'}
              </h3>
              {connection.setupRequired && (
                <>
                  <p>
                    The first account administers this instance and its one
                    household. No email address is needed.
                  </p>
                  <label>
                    Household name
                    <input
                      value={householdName}
                      maxLength={80}
                      onChange={(event) => setHouseholdName(event.target.value)}
                      required
                    />
                  </label>
                </>
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
                  autoComplete={
                    connection.setupRequired
                      ? 'new-password'
                      : 'current-password'
                  }
                  value={password}
                  maxLength={128}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              {connection.setupRequired && (
                <small>
                  Use 3–32 letters, numbers, dots, underscores, or hyphens for
                  your username and 12–128 characters for your password.
                </small>
              )}
              <button className="button primary" disabled={busy}>
                {connection.setupRequired ? 'Create administrator' : 'Sign in'}
              </button>
            </form>
          ) : (
            <button
              className="button secondary"
              disabled={busy}
              onClick={connection.refresh}
            >
              Retry connection
            </button>
          )}
          {!connection.session && !connection.checking && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setError('');
                connection.forget();
              }}
            >
              Disconnect backend
            </button>
          )}
          {connection.config.token &&
            !connection.session &&
            !connection.checking && (
              <p>
                Disconnecting forgets this device’s connection. The server
                session expires after 30 days; sign out while connected to
                revoke it immediately.
              </p>
            )}
        </section>
      )}
      {connection.config &&
        connection.session?.account.role === 'administrator' && (
          <HouseholdAccounts config={connection.config} />
        )}
    </section>
  );
}
