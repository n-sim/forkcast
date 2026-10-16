export interface BackendConfig {
  url: string;
  token?: string;
  accountId?: string;
  householdId?: string;
}

export interface Account {
  id: string;
  householdId: string;
  username: string;
  role: 'administrator' | 'member';
  active: boolean;
}

export interface BackendSession {
  account: Account;
  household: { id: string; name: string };
}

export class BackendError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export function backendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendError('Enter a full backend URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BackendError(
      'Use HTTPS for your backend, or HTTP on localhost. Omit credentials, query strings, and fragments.',
    );
  }
  return url.href.replace(/\/$/, '');
}

export async function backendRequest<T>(
  config: BackendConfig,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.url}/api${path}`, {
      method,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BackendError(
      'Backend unavailable. Check the URL, network, and allowed frontend origin, then try again.',
    );
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new BackendError(
      error?.message ?? 'The backend could not complete this request.',
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

const connectionKey = 'forkcast-backend';

export function loadBackendConfig(): BackendConfig | null {
  try {
    const stored = localStorage.getItem(connectionKey);
    if (!stored) return null;
    const config = JSON.parse(stored) as BackendConfig;
    return {
      url: backendUrl(config.url),
      token: typeof config.token === 'string' ? config.token : undefined,
      accountId:
        typeof config.accountId === 'string' ? config.accountId : undefined,
      householdId:
        typeof config.householdId === 'string' ? config.householdId : undefined,
    };
  } catch {
    return null;
  }
}

export function saveBackendConfig(config: BackendConfig | null) {
  if (config) localStorage.setItem(connectionKey, JSON.stringify(config));
  else localStorage.removeItem(connectionKey);
}
