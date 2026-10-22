import { execute } from './core';

// ChatGPT is reached only through the application core: the installed app's
// embedded core, or the household server's core for a browser. Credentials
// never reach this code; it sees connection state and workflow text.

export type AiState =
  | 'unconfigured'
  | 'authorizing'
  | 'connected'
  | 'denied'
  | 'expired'
  | 'reconnect_required'
  | 'transferring'
  | 'transfer_failed'
  | 'unavailable';

export interface AiStatus {
  state: AiState;
  /** `device` runs with a session on this device, `server` on the household server. */
  target: 'device' | 'server';
  email: string | null;
  message: string | null;
  serverUrl: string | null;
  account: string | null;
  /** Sign-in can start from this host (the installed app). */
  canAuthorize: boolean;
  canRetry: boolean;
}

export interface AiModel {
  slug: string;
  displayName: string;
}

export const aiStatus = () => execute<AiStatus>('aiStatus');

export const aiModels = () => execute<AiModel[]>('aiModels', {}, 30_000);

export const aiSignOut = () => execute<AiStatus>('aiSignOut', {}, 40_000);

export const aiRetryTransfer = () => execute<AiStatus>('aiRetryTransfer');

export const aiCancelTransfer = () => execute<AiStatus>('aiCancelTransfer');

export const aiCancelAuthorization = () =>
  execute<AiStatus>('aiCancelAuthorization');

/**
 * Starts sign-in and returns the address to open in the person's own
 * browser. A joined app must name the server and account it is granting.
 */
export async function aiAuthorize(selection?: {
  serverUrl: string;
  accountId: string;
}): Promise<string> {
  const result = await execute<{ authorizationUrl: string }>(
    'aiAuthorize',
    selection ?? {},
  );
  const destination = new URL(result.authorizationUrl);
  if (
    !(
      destination.origin === 'https://auth.openai.com' ||
      (destination.protocol === 'http:' && destination.hostname === '127.0.0.1')
    ) ||
    destination.pathname !== '/api/accounts/authorize'
  )
    throw new Error('Forkcast returned an invalid sign-in address.');
  return destination.href;
}

/** The one execution interface every AI workflow uses. */
export async function aiExecute(request: {
  model: string;
  instructions: string;
  input: string;
}): Promise<string> {
  // A generation can legitimately take minutes.
  return (await execute<{ text: string }>('aiExecute', request, 200_000)).text;
}

export interface AiPreferences {
  recipePrompt: string;
  recipeModel: string | null;
  planPrompt: string;
  /** How supermarket products are chosen when filling a Gurkerl cart. */
  cartPrompt: string;
}

export const loadAiPreferences = () => execute<AiPreferences>('aiPreferences');

export const saveRecipeModel = (model: string | null) =>
  execute('setRecipeModel', { model });
