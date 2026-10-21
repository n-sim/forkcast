import { useEffect, useState, type FormEvent } from 'react';
import {
  authenticateServer,
  cancelJoin,
  checkServerCertificate,
  changeAccount,
  completeJoin,
  connectServer,
  createAccount,
  disconnectFromHousehold,
  listAccounts,
  reviewJoin,
  signInToHousehold,
  signOutOfHousehold,
  syncNow,
  trustServerCertificate,
  type HouseholdAccount,
  type JoinReview,
  type SyncStatus,
} from './household-client';

function message(failure: unknown) {
  return failure instanceof Error ? failure.message : String(failure);
}

function ConfirmCertificate({
  url,
  fingerprint,
  replacing = false,
  busy,
  onConfirm,
  onCancel,
}: {
  url: string;
  fingerprint: string;
  replacing?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      className="account-form"
      aria-labelledby="server-certificate-heading"
    >
      <h3 id="server-certificate-heading">
        {replacing
          ? "Confirm the server's new certificate"
          : "Confirm the server's certificate"}
      </h3>
      <p>
        {replacing
          ? `${url} now presents a different certificate than the one you confirmed. Accept it only if the server's certificate was replaced on purpose. `
          : `${url} uses its own certificate instead of one from a public certificate authority. `}
        Compare this fingerprint with the one your server shows: the server
        prints it when it starts, and{' '}
        <code>forkcast-backend --fingerprint</code> shows it again. Continue
        only if they match; this app then accepts only this certificate from the
        server.
      </p>
      <p>
        <code className="fingerprint">{fingerprint}</code>
      </p>
      <div className="account-actions">
        <button className="button primary" disabled={busy} onClick={onConfirm}>
          {replacing
            ? 'The fingerprints match, use it'
            : 'The fingerprints match, connect'}
        </button>
        <button className="button secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function Backend({
  url,
  certificate,
}: {
  url: string | null;
  certificate: string | null;
}) {
  return (
    <>
      <p>Backend: {url}</p>
      {certificate && (
        <p>
          Server certificate fingerprint (SHA-256):{' '}
          <code className="fingerprint">{certificate}</code>
        </p>
      )}
    </>
  );
}

export function HouseholdAccounts({ enabled }: { enabled: boolean }) {
  const [accounts, setAccounts] = useState<HouseholdAccount[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [resetAccount, setResetAccount] = useState<HouseholdAccount | null>(
    null,
  );
  const [replacementPassword, setReplacementPassword] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    void listAccounts()
      .then((accounts) => {
        if (!canceled) setAccounts(accounts);
      })
      .catch((failure) => {
        if (!canceled) setError(message(failure));
      });
    return () => {
      canceled = true;
    };
  }, [enabled]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const account = await createAccount(username, password);
      setPassword('');
      setUsername('');
      setAccounts((accounts) => [...accounts, account]);
      setNotice(
        `Account created for ${account.username}. Share the backend URL and credentials with them directly.`,
      );
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function change(
    account: HouseholdAccount,
    body: { active: boolean } | { password: string },
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await changeAccount(account.id, body);
      setAccounts((accounts) =>
        accounts.map((item) => (item.id === updated.id ? updated : item)),
      );
      setResetAccount(null);
      setReplacementPassword('');
      setNotice(
        'password' in body
          ? `Password reset for ${account.username}. Their existing sessions have ended.`
          : `Account ${updated.active ? 'enabled' : 'disabled'} for ${account.username}.`,
      );
    } catch (failure) {
      setError(message(failure));
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
      {notice && (
        <p role="status" aria-label="Account administration">
          {notice}
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

function CredentialsForm({
  setup,
  busy,
  onSubmit,
}: {
  setup: boolean;
  busy: boolean;
  onSubmit: (input: {
    username: string;
    password: string;
    householdName: string;
  }) => void;
}) {
  const [householdName, setHouseholdName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ username, password, householdName });
        setPassword('');
      }}
    >
      <h3>{setup ? 'Set up your household' : 'Sign in'}</h3>
      {setup && (
        <>
          <p>
            The first account administers this instance and its one household.
            No email address is needed.
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
          autoComplete={setup ? 'new-password' : 'current-password'}
          value={password}
          maxLength={128}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {setup && (
        <small>
          Use 3–32 letters, numbers, dots, underscores, or hyphens for your
          username and 12–128 characters for your password.
        </small>
      )}
      <button className="button primary" disabled={busy}>
        {setup ? 'Create administrator' : 'Sign in'}
      </button>
    </form>
  );
}

function JoinReviewPanel({
  review,
  busy,
  onJoin,
  onCancel,
}: {
  review: JoinReview;
  busy: boolean;
  onJoin: (input: {
    recipeIds: string[];
    cookingIds: string[];
    useDeviceShoppingList: boolean;
    adoptPersonal: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [recipes, setRecipes] = useState(
    () =>
      new Set(
        review.recipes
          .filter((recipe) => !recipe.collides)
          .map((recipe) => recipe.id),
      ),
  );
  const [cookings, setCookings] = useState(
    () => new Set(review.cookings.map((cooking) => cooking.id)),
  );
  const [deviceList, setDeviceList] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const toggle =
    (set: Set<string>, update: (next: Set<string>) => void, id: string) =>
    (event: { target: { checked: boolean } }) => {
      const next = new Set(set);
      if (event.target.checked) next.add(id);
      else next.delete(id);
      update(next);
    };
  const personal =
    review.personal.ratings +
    review.personal.foodLogEntries +
    review.personal.cookingSessions;
  return (
    <section className="panel" aria-labelledby="join-review-heading">
      <h2 id="join-review-heading">Review before joining</h2>
      <p>
        You are joining <strong>{review.household.name}</strong> as{' '}
        <strong>{review.account.username}</strong>. Nothing is shared or
        replaced until you choose below, and cancelling changes neither this
        device nor the household.
      </p>
      <fieldset disabled={busy}>
        <legend>Recipes to contribute</legend>
        {review.recipes.length === 0 && <p>This device has no recipes.</p>}
        {review.recipes.map((recipe) => (
          <label key={recipe.id}>
            <input
              type="checkbox"
              checked={recipes.has(recipe.id) || recipe.collides}
              disabled={recipe.collides}
              onChange={toggle(recipes, setRecipes, recipe.id)}
            />
            {recipe.name}
            {recipe.collides && (
              <strong>
                {' '}
                · The household already has a recipe with this ID. Both versions
                are kept as alternatives to choose from; neither overwrites the
                other.
              </strong>
            )}
          </label>
        ))}
        <p className="section-note">
          Recipes you leave out stay on this device, hidden from the household,
          and are not published. The household has {review.householdRecipes}{' '}
          {review.householdRecipes === 1 ? 'recipe' : 'recipes'}.
        </p>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Planned cookings to add</legend>
        {review.cookings.length === 0 && <p>No device planned cookings.</p>}
        {review.cookings.map((cooking) => (
          <label key={cooking.id}>
            <input
              type="checkbox"
              checked={cookings.has(cooking.id)}
              onChange={toggle(cookings, setCookings, cooking.id)}
            />
            {cooking.recipeName || 'Recipe unavailable'} · {cooking.cookingDate}{' '}
            · {cooking.portions} portions
            {cooking.likelyDuplicate && (
              <strong> · Possible duplicate in household plan</strong>
            )}
          </label>
        ))}
        <label>
          <input
            type="radio"
            name="join-shopping-list"
            checked={!deviceList}
            onChange={() => setDeviceList(false)}
          />
          Keep household shopping list
        </label>
        <p>
          {review.householdShoppingList
            ? `${review.householdShoppingList.startDate} through ${review.householdShoppingList.endDate}; ${review.householdShoppingList.items + review.householdShoppingList.manualItems} items`
            : 'The household has no shopping list yet.'}
        </p>
        {review.deviceShoppingList && (
          <>
            <label>
              <input
                type="radio"
                name="join-shopping-list"
                checked={deviceList}
                onChange={() => setDeviceList(true)}
              />
              Replace with device shopping list
            </label>
            <p>
              {review.deviceShoppingList.startDate} through{' '}
              {review.deviceShoppingList.endDate};{' '}
              {review.deviceShoppingList.items +
                review.deviceShoppingList.manualItems}{' '}
              items; replaces the household’s current list.
            </p>
          </>
        )}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Your personal records</legend>
        <label>
          <input
            type="checkbox"
            checked={adopt}
            onChange={(event) => setAdopt(event.target.checked)}
          />
          Move this device’s ratings, food log, cooking sessions, and AI
          settings to {review.account.username}
        </label>
        <p className="section-note">
          {personal
            ? `${review.personal.ratings} ratings, ${review.personal.foodLogEntries} food-log entries, ${review.personal.cookingSessions} unfinished cooking sessions. Personal records never become household records.`
            : 'This device has no personal records to move.'}{' '}
          Without this they stay on this device and are hidden while you are
          joined.
        </p>
      </fieldset>
      <div className="form-actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            onJoin({
              recipeIds: [...recipes],
              cookingIds: [...cookings],
              useDeviceShoppingList: deviceList,
              adoptPersonal: adopt,
            })
          }
        >
          Join and share selected data
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            onJoin({
              recipeIds: [],
              cookingIds: [],
              useDeviceShoppingList: false,
              adoptPersonal: false,
            })
          }
        >
          Continue with household data
        </button>
        <button className="button secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="section-note">
        Continue with household data replaces this device’s meal plan and
        shopping list with the household’s and keeps your recipes on this device
        without publishing them. Cancel keeps both the device and household data
        untouched.
      </p>
    </section>
  );
}

export function HouseholdSettings({
  status,
  refresh,
}: {
  status: SyncStatus | null;
  refresh: () => Promise<void>;
}) {
  const [url, setUrl] = useState('http://127.0.0.1:8787');
  const [review, setReview] = useState<JoinReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signInPaused, setSignInPaused] = useState(false);
  const [untrusted, setUntrusted] = useState<{
    url: string;
    fingerprint: string;
  } | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [certificateNotice, setCertificateNotice] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!status)
    return (
      <section className="panel account-form">
        <h2>Backend &amp; accounts</h2>
        <p role="status">Loading…</p>
      </section>
    );
  const joining = status.pendingJoin;
  return (
    <section
      className="panel account-form"
      aria-labelledby="backend-accounts-heading"
    >
      <h2 id="backend-accounts-heading">Backend &amp; accounts</h2>
      <section>
        <h3>Standalone records stay on this device</h3>
        <p>
          Everything works on this device without an account. Connecting to a
          household server lets you share recipes, the meal plan, and the
          shopping list with your household. You choose what to publish before
          anything leaves this device. Food logs, cooking sessions, ratings, and
          AI settings stay personal.
        </p>
      </section>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!status.bound && !joining && untrusted && (
        <ConfirmCertificate
          url={untrusted.url}
          fingerprint={untrusted.fingerprint}
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              await connectServer(untrusted.url, untrusted.fingerprint);
              setUntrusted(null);
            })
          }
          onCancel={() => setUntrusted(null)}
        />
      )}
      {!status.bound && !joining && !untrusted && (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const probe = await connectServer(url);
              if (probe.untrustedCertificate)
                setUntrusted({
                  url: probe.serverUrl,
                  fingerprint: probe.untrustedCertificate,
                });
            });
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
      )}
      {!status.bound && joining && !joining.account && (
        <section className="account-form">
          <Backend url={joining.serverUrl} certificate={joining.certificate} />
          <CredentialsForm
            setup={joining.setupRequired}
            busy={busy}
            onSubmit={({ username, password, householdName }) =>
              void run(async () => {
                await authenticateServer({
                  setup: joining.setupRequired,
                  username,
                  password,
                  householdName,
                });
              })
            }
          />
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void run(cancelJoin)}
          >
            Disconnect backend
          </button>
        </section>
      )}
      {!status.bound && joining?.account && (
        <section className="account-form">
          <Backend url={joining.serverUrl} certificate={joining.certificate} />
          <p>
            Signed in as <strong>{joining.account.username}</strong> (
            {joining.account.role === 'administrator'
              ? 'Administrator'
              : 'Household member'}
            ) of <strong>{joining.household?.name}</strong>. Review what joining
            will publish or replace.
          </p>
          {review ? (
            <JoinReviewPanel
              review={review}
              busy={busy}
              onCancel={() =>
                void run(async () => {
                  await cancelJoin();
                  setReview(null);
                })
              }
              onJoin={(selection) =>
                void run(async () => {
                  await completeJoin(selection);
                  setReview(null);
                })
              }
            />
          ) : (
            <div className="account-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => setReview(await reviewJoin()))
                }
              >
                Enable data synchronization
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void run(cancelJoin)}
              >
                Disconnect backend
              </button>
            </div>
          )}
        </section>
      )}
      {status.bound && (
        <section className="account-form">
          <Backend
            url={status.serverUrl}
            certificate={status.serverCertificate}
          />
          {status.serverCertificate &&
            (replacement ? (
              <ConfirmCertificate
                url={status.serverUrl ?? ''}
                fingerprint={replacement}
                replacing
                busy={busy}
                onConfirm={() =>
                  void run(async () => {
                    await trustServerCertificate(replacement);
                    setReplacement(null);
                  })
                }
                onCancel={() => setReplacement(null)}
              />
            ) : (
              <div className="account-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setCertificateNotice('');
                      const check = await checkServerCertificate();
                      if (
                        check.presented &&
                        check.presented !== check.confirmed
                      )
                        setReplacement(check.presented);
                      else
                        setCertificateNotice(
                          'The server presents the certificate you confirmed.',
                        );
                    })
                  }
                >
                  Check the server&apos;s certificate
                </button>
                {certificateNotice && <p role="status">{certificateNotice}</p>}
              </div>
            ))}
          {status.signedIn && status.activeAccount ? (
            <>
              <h3>Household</h3>
              <p>
                Signed in as <strong>{status.activeAccount.username}</strong> (
                {status.activeAccount.role === 'administrator'
                  ? 'Administrator'
                  : 'Household member'}
                ).
              </p>
              <p>
                Recipes, cooking history, the meal plan, and the shopping list
                belong to the household. Food logs, nutrition goals, ratings, AI
                settings, and cooking sessions belong to each person.
              </p>
              <div className="account-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => void (await signOutOfHousehold()))
                  }
                >
                  Sign out
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => void (await disconnectFromHousehold()))
                  }
                >
                  Disconnect backend
                </button>
              </div>
            </>
          ) : (
            <>
              <p role="status">
                {status.paused
                  ? 'Disconnected. Local records and your household link are kept.'
                  : 'Signed out. Your household’s recipes, plan, and shopping list stay available; private records are hidden until you sign in.'}
              </p>
              {(!status.paused || signInPaused) && (
                <CredentialsForm
                  setup={false}
                  busy={busy}
                  onSubmit={({ username, password }) =>
                    void run(async () => {
                      await signInToHousehold(username, password);
                      setSignInPaused(false);
                    })
                  }
                />
              )}
              {status.paused && !signInPaused && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setSignInPaused(true)}
                >
                  Reconnect
                </button>
              )}
              {status.pendingForOtherAccounts > 0 && (
                <p className="section-note">
                  {status.pendingForOtherAccounts} pending changes belong to
                  another account on this device. Only that account can deliver
                  them.
                </p>
              )}
            </>
          )}
        </section>
      )}
      {status.bound &&
        status.signedIn &&
        status.activeAccount?.role === 'administrator' && (
          <HouseholdAccounts enabled />
        )}
    </section>
  );
}

export function SyncPanel({
  status,
  refresh,
}: {
  status: SyncStatus | null;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!status?.bound) return null;
  async function sync() {
    setBusy(true);
    setError('');
    try {
      await syncNow();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  const working = busy || status.syncing;
  return (
    <section className="panel account-form" aria-labelledby="data-sync-heading">
      <h2 id="data-sync-heading">Data synchronization</h2>
      <p>
        Recipes, cover photos, nutrition, the meal plan, and the shopping list
        are shared with your household. Your ratings synchronize only with your
        account. Food logs and cooking progress stay on this device.
      </p>
      <p role="status" aria-label="Data synchronization">
        {working
          ? 'Synchronizing…'
          : status.lastError
            ? `Pending synchronization. ${status.lastError}`
            : status.pending
              ? `${status.pending} pending changes saved on this device.`
              : 'Up to date.'}
      </p>
      <p>
        Collection linked to {status.serverUrl}. Local changes retry
        automatically when connected.
      </p>
      <button
        className="button secondary"
        disabled={working || !status.signedIn}
        onClick={() => void sync()}
      >
        Sync now
      </button>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </section>
  );
}
