export const companionKey = 'forkcast-ai-companion';

export interface ChatGptStatus {
  state: 'unconfigured' | 'authorizing' | 'connected' | 'reconnect_required';
  email: string | null;
  message: string | null;
}

export function savedCompanion(): string | null {
  try {
    const stored = localStorage.getItem(companionKey);
    return stored ? companionUrl(stored) : null;
  } catch {
    return null;
  }
}

export async function companionStatus(url: string): Promise<ChatGptStatus> {
  const result = await companionRequest<ChatGptStatus>(url, '/status');
  if (
    ![
      'unconfigured',
      'authorizing',
      'connected',
      'reconnect_required',
    ].includes(result.state)
  ) {
    throw new Error(
      'This address is not a Forkcast AI companion. Check the companion URL.',
    );
  }
  return result;
}

export function companionUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Use an HTTP companion URL on 127.0.0.1 with no path or credentials.',
    );
  }
  return url.origin;
}

export async function companionRequest<T>(
  url: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        'X-Forkcast-Companion': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([
        AbortSignal.timeout(path === '/execute' ? 190_000 : 8_000),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch {
    throw new Error(
      'Companion unavailable. Start the native AI companion on this device, check its allowed frontend origin, then try again. Manual workflows remain available.',
    );
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      error?.message ??
        'The companion could not complete this request. Try connecting again.',
    );
  }
  return (await response.json()) as T;
}
