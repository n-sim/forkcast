import { useEffect, useRef, useState } from 'react';
import type { BackendConfig, BackendSession } from './backend-client';
import {
  enableRecipeSync,
  loadSyncState,
  recipeSyncAccount,
  recipeConflicts,
  type RecipeConflict,
  subscribeToRecipeChanges,
  type SyncBinding,
} from './recipe-sync-store';
import { synchronizeRecipes } from './recipe-sync';

export function useRecipeSync(config: BackendConfig | null) {
  const [binding, setBinding] = useState<SyncBinding>();
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [alternatives, setAlternatives] = useState<RecipeConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useRef<() => void>(() => {});
  const url = config?.url;
  const token = config?.token;
  const accountId = config?.accountId;
  const householdId = config?.householdId;

  useEffect(() => {
    let active = true;
    let running = false;
    let requested = false;
    let debounce: number | undefined;
    async function refresh(sync = false) {
      if (running) {
        requested ||= sync;
        return;
      }
      running = true;
      try {
        const state = await loadSyncState(accountId);
        if (!active) return;
        setBinding(state.binding);
        setPending(
          state.revisions.filter((revision) => revision.pending).length +
            state.ratings.length,
        );
        setConflicts(state.conflicts);
        setAlternatives(recipeConflicts(state));
        if (!state.binding) return;
        if (
          url !== state.binding.url ||
          (householdId && householdId !== state.binding.householdId)
        ) {
          setError(
            'This device’s collection is linked to another household. Pending changes stay on this device.',
          );
          return;
        }
        const current = url ? { url, token, accountId, householdId } : null;
        if (!recipeSyncAccount(current, state.binding)) {
          setError('Sign in to synchronize. Changes stay on this device.');
          return;
        }
        if (!sync) return;
        setBusy(true);
        await synchronizeRecipes({ url, token, accountId, householdId });
        const saved = await loadSyncState(accountId);
        if (active) {
          setPending(
            saved.revisions.filter((revision) => revision.pending).length +
              saved.ratings.length,
          );
          setConflicts(saved.conflicts);
          setAlternatives(recipeConflicts(saved));
          setError('');
        }
      } catch (error) {
        if (active)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
        if (active) {
          setBusy(false);
          if (requested) {
            requested = false;
            void refresh(true);
          }
        }
      }
    }
    run.current = () => void refresh(true);
    const changed = (pending: boolean) => {
      if (!pending) {
        void refresh();
        return;
      }
      setPending((count) => Math.max(1, count));
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void refresh(true), 100);
    };
    const unsubscribe = subscribeToRecipeChanges(changed);
    const retry = () => void refresh(true);
    const interval = window.setInterval(retry, 5_000);
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    void refresh(true);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
      window.clearTimeout(debounce);
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
    };
  }, [url, token, accountId, householdId]);

  return {
    binding,
    pending,
    conflicts,
    alternatives,
    busy,
    error,
    sync: () => run.current(),
  };
}

export function RecipeSync({
  config,
  session,
  sync,
}: {
  config: BackendConfig | null;
  session: BackendSession | null;
  sync: ReturnType<typeof useRecipeSync>;
}) {
  const [error, setError] = useState('');
  const [enabling, setEnabling] = useState(false);
  async function enable() {
    if (!config || !session) return;
    setEnabling(true);
    setError('');
    try {
      await enableRecipeSync(config, session.household.id, session.account.id);
      sync.sync();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnabling(false);
    }
  }
  return (
    <section
      className="panel account-form"
      aria-labelledby="recipe-sync-heading"
    >
      <h3 id="recipe-sync-heading">Recipe synchronization</h3>
      <p>
        Share your recipe collection, cover photos, and retained nutrition with
        your household. Your ratings synchronize only with your account. Plans,
        food logs, and cooking progress stay on this device.
      </p>
      {!sync.binding ? (
        <>
          <p>
            Enabling uploads existing recipes and adopts this device’s personal
            ratings into the signed-in account. Local records stay available
            offline.
          </p>
          <button
            className="button primary"
            disabled={!session || enabling}
            onClick={() => void enable()}
          >
            Enable recipe synchronization
          </button>
        </>
      ) : (
        <>
          <p role="status" aria-label="Recipe synchronization">
            {sync.busy
              ? 'Synchronizing…'
              : sync.error
                ? `Pending synchronization. ${sync.error}`
                : sync.pending
                  ? `${sync.pending} pending changes saved on this device.`
                  : 'Up to date.'}
          </p>
          <p>
            Collection linked to {sync.binding.url}. Local changes retry
            automatically when connected.
          </p>
          <button
            className="button secondary"
            disabled={sync.busy || !config?.token}
            onClick={sync.sync}
          >
            Sync now
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </section>
  );
}
