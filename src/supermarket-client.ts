import { execute } from './core';
import type { Unit } from './domain';

// Gurkerl is reached only through the installed app's own core, which keeps
// the session in protected storage on this device. This code sees connection
// state and handoff results, never credentials.

export type SupermarketState =
  | 'unconfigured'
  | 'authorizing'
  | 'connected'
  | 'denied'
  | 'expired'
  | 'reconnect_required';

export interface SupermarketStatus {
  state: SupermarketState;
  message: string | null;
  /** Only an installed app can connect Gurkerl and fill carts. */
  canConnect: boolean;
}

export type CartItemStatus = 'added' | 'failed' | 'not_added' | 'skipped';

export interface CartItem {
  itemId: string;
  name: string;
  quantity: number | null;
  unit: Unit;
  status: CartItemStatus;
  product: string | null;
  note: string | null;
}

export interface CartHandoff {
  listId: string;
  /** False when the handoff stopped early; `message` says why. */
  complete: boolean;
  message: string | null;
  items: CartItem[];
}

export const supermarketStatus = () =>
  execute<SupermarketStatus>('supermarketStatus');

export const supermarketCancelAuthorization = () =>
  execute<SupermarketStatus>('supermarketCancelAuthorization');

export const supermarketSignOut = () =>
  execute<SupermarketStatus>('supermarketSignOut');

/** Starts Gurkerl sign-in and returns the address to open in the person's own browser. */
export async function supermarketAuthorize(): Promise<string> {
  const { authorizationUrl } = await execute<{ authorizationUrl: string }>(
    'supermarketAuthorize',
    {},
    30_000,
  );
  const destination = new URL(authorizationUrl);
  if (
    destination.protocol !== 'https:' &&
    !(destination.protocol === 'http:' && destination.hostname === '127.0.0.1')
  )
    throw new Error('Forkcast returned an invalid sign-in address.');
  return destination.href;
}

/** Fills the Gurkerl cart from the reviewed list. It can take minutes. */
export const fillSupermarketCart = (listId: string, model: string) =>
  execute<CartHandoff>('fillSupermarketCart', { listId, model }, 600_000);

export const saveCartPrompt = (prompt: string) =>
  execute('setCartPrompt', { prompt });
