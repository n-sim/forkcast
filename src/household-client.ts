import { useCallback, useEffect, useState } from 'react';
import { execute, isNative, subscribeToTopics, CoreError } from './core';

// The installed app's relationship with a household server, as the core
// reports it. Synchronization itself runs in Rust; this is display and intent.

export interface AccountInfo {
  id: string;
  username: string | null;
  role: 'administrator' | 'member';
}

export interface PendingJoin {
  serverUrl: string;
  setupRequired: boolean;
  account: AccountInfo | null;
  household: { id: string; name: string } | null;
}

export interface SyncStatus {
  protocol: number;
  bound: boolean;
  serverUrl: string | null;
  remoteHouseholdId: string | null;
  activeAccount: AccountInfo | null;
  signedIn: boolean;
  signedOut: boolean;
  paused: boolean;
  syncing: boolean;
  pending: number;
  pendingForOtherAccounts: number;
  lastError: string | null;
  lastSyncedAt: number | null;
  conflicts: { recipes: number; planning: number };
  pendingJoin: PendingJoin | null;
}

export interface JoinReview {
  serverUrl: string;
  account: AccountInfo;
  household: { id: string; name: string };
  recipes: { id: string; name: string; collides: boolean }[];
  householdRecipes: number;
  cookings: {
    id: string;
    recipeId: string;
    recipeName: string;
    cookingDate: string;
    cookingTime: string | null;
    portions: number;
    likelyDuplicate: boolean;
  }[];
  householdCookings: number;
  deviceShoppingList: ListSummary | null;
  householdShoppingList: ListSummary | null;
  personal: {
    ratings: number;
    foodLogEntries: number;
    cookingSessions: number;
  };
}

interface ListSummary {
  id: string;
  startDate: string;
  endDate: string;
  items: number;
  manualItems: number;
}

export interface JoinSelection {
  recipeIds: string[];
  cookingIds: string[];
  useDeviceShoppingList: boolean;
  adoptPersonal: boolean;
}

export interface HouseholdAccount {
  id: string;
  householdId: string;
  username: string;
  role: 'administrator' | 'member';
  active: boolean;
}

export const syncStatus = () => execute<SyncStatus>('syncStatus');
export const syncNow = () => execute<SyncStatus>('syncNow');
export const connectServer = (serverUrl: string) =>
  execute<{ serverUrl: string; setupRequired: boolean }>('connectServer', {
    serverUrl,
  });
export const authenticateServer = (input: {
  setup: boolean;
  username: string;
  password: string;
  householdName?: string;
}) => execute<{ account: AccountInfo }>('authenticateServer', input);
export const reviewJoin = () => execute<JoinReview>('reviewJoin');
export const completeJoin = (selection: JoinSelection) =>
  execute<SyncStatus>('completeJoin', selection);
export const cancelJoin = () => execute<void>('cancelJoin');
export const signInToHousehold = (username: string, password: string) =>
  execute<SyncStatus>('signIn', { username, password });
export const signOutOfHousehold = () => execute<SyncStatus>('signOut');
export const disconnectFromHousehold = () => execute<SyncStatus>('disconnect');
export const listAccounts = () => execute<HouseholdAccount[]>('accounts');
export const createAccount = (username: string, password: string) =>
  execute<HouseholdAccount>('createAccount', { username, password });
export const changeAccount = (
  id: string,
  change: { active: boolean } | { password: string },
) => execute<HouseholdAccount>('changeAccount', { id, ...change });

/** The installed app's synchronization state; null in a browser, where the server is the source. */
export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!isNative) return;
    try {
      setStatus(await syncStatus());
      setError('');
    } catch (failure) {
      setError(
        failure instanceof CoreError ? failure.message : String(failure),
      );
    }
  }, []);
  useEffect(() => {
    if (!isNative) return;
    void refresh();
    const unsubscribe = subscribeToTopics(
      ['sync', 'recipes', 'planning', 'ratings'],
      () => void refresh(),
    );
    const interval = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener('focus', refresh as () => void);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh as () => void);
    };
  }, [refresh]);
  return { status, error, refresh };
}
