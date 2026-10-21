import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializeDomain } from './domain';
import {
  loadRecipeCollection,
  loadPersonalRecipeRatings,
  loadCookingSessions,
} from './recipe-store';
import {
  BrowserServerRequired,
  BrowserSignIn,
  BrowserUnreachable,
  useBrowserSession,
  type BrowserSession,
} from './BrowserAccount';
import {
  hostStatus,
  isNative,
  openDataFolder,
  retryStartup,
  type HostStatus,
} from './core';
import './styles.css';

// Packaged assets are replaced only by application releases, so an older
// browser deployment's service worker is removed. Its stored site data is not.
if ('serviceWorker' in navigator && !isNative) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      registrations.forEach((registration) => void registration.unregister()),
    );
}

type Data = Parameters<typeof App>[0];

// The calculation engine downloads and compiles while the host is checked and
// the collection loads, rather than before either can start.
const domain = initializeDomain().then(
  () => true,
  () => false,
);

const engineFailure = (
  <StartupError
    message="The calculation engine could not start."
    onRetry={() => window.location.reload()}
    folder={false}
  />
);

function StartupError({
  message,
  onRetry,
  folder,
}: {
  message: string;
  onRetry: () => void;
  folder: boolean;
}) {
  return (
    <main className="startup-error" id="main-content">
      <h1>We couldn’t open your recipe collection</h1>
      <p role="alert">{message}</p>
      <p>Your stored data has not been changed or deleted.</p>
      <div className="form-actions">
        <button className="button primary" onClick={onRetry}>
          Try again
        </button>
        {folder && (
          <button
            className="button secondary"
            onClick={() => void openDataFolder()}
          >
            Open data folder
          </button>
        )}
      </div>
    </main>
  );
}

function Loaded({ browserSession }: { browserSession?: BrowserSession }) {
  const [data, setData] = useState<Data | null>(null);
  const [failure, setFailure] = useState('');
  const [engineFailed, setEngineFailed] = useState(false);
  const load = useCallback(async () => {
    setFailure('');
    try {
      const [ready, collection, ratings, sessions] = await Promise.all([
        domain,
        loadRecipeCollection(),
        loadPersonalRecipeRatings(),
        loadCookingSessions(),
      ]);
      if (!ready) {
        setEngineFailed(true);
        return;
      }
      setData({
        initialRecipes: collection.recipes,
        initialCoverPhotos: collection.photos,
        initialRatings: ratings,
        initialCookingSessions: sessions,
        browserSession,
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [browserSession]);
  useEffect(() => {
    void load();
  }, [load]);
  if (engineFailed) return engineFailure;
  if (failure)
    return (
      <StartupError
        message={failure}
        onRetry={() => void load()}
        folder={isNative}
      />
    );
  if (!data)
    return <p className="startup-loading">Opening your recipe collection…</p>;
  return <App key={browserSession?.account.id ?? 'app'} {...data} />;
}

function Browser() {
  const { state, retry } = useBrowserSession(true);
  if (state.phase === 'checking')
    return <p className="startup-loading">Opening your recipe collection…</p>;
  if (state.phase === 'unreachable')
    return <BrowserUnreachable message={state.message} onRetry={retry} />;
  if (state.phase === 'no-server')
    return <BrowserServerRequired onRetry={retry} />;
  if (state.phase === 'signed-out')
    return (
      <BrowserSignIn
        setupRequired={state.setupRequired}
        message={state.message}
      />
    );
  return <Loaded browserSession={state.session} />;
}

function Native() {
  const [host, setHost] = useState<HostStatus | null>(null);
  const check = useCallback(async () => setHost(await hostStatus()), []);
  useEffect(() => {
    void check();
  }, [check]);
  if (!host)
    return <p className="startup-loading">Opening your recipe collection…</p>;
  if (host.state === 'failed')
    return (
      <StartupError
        message={
          host.message ?? 'Forkcast could not open its storage on this device.'
        }
        folder
        onRetry={() => void retryStartup().then(setHost)}
      />
    );
  return <Loaded />;
}

createRoot(document.getElementById('root')!).render(
  isNative ? <Native /> : <Browser />,
);
