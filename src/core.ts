// The one interface to Forkcast's application core. In the installed app it is
// reached through the native bridge; in a browser it is the household server's
// HTTP interface. Both carry the same operations and error contract, so the
// frontend holds no durable store and no workflow rules of its own.

export type Topic =
  | 'recipes'
  | 'ratings'
  | 'planning'
  | 'cookingSessions'
  | 'cookingHistory'
  | 'foodLog'
  | 'preferences'
  | 'sync'
  | 'ai';

export interface CoreChange {
  scope: { kind: 'household' | 'person'; id: string };
  topic: Topic;
}

export type ErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'rate_limited'
  | 'unsupported'
  | 'internal'
  | 'unavailable'
  | 'protocol_mismatch'
  | 'connection_required';

export class CoreError extends Error {
  constructor(
    message: string,
    public kind: ErrorKind = 'internal',
    public fields?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export const isNative =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function asCoreError(failure: unknown): CoreError {
  if (failure instanceof CoreError) return failure;
  if (typeof failure === 'object' && failure && 'message' in failure) {
    const { message, kind, fields } = failure as {
      message: string;
      kind?: ErrorKind;
      fields?: CoreError['fields'];
    };
    return new CoreError(String(message), kind ?? 'internal', fields);
  }
  return new CoreError(String(failure));
}

const sessionKey = 'forkcast-session';

/** The browser's household-server session. Only a bearer token is kept. */
export function browserToken(): string | null {
  try {
    return localStorage.getItem(sessionKey);
  } catch {
    return null;
  }
}

const endedKey = 'forkcast-session-ended';

/** True once, after the server ended this browser's session. */
export function takeSessionEnded(): boolean {
  try {
    const ended = sessionStorage.getItem(endedKey) === '1';
    sessionStorage.removeItem(endedKey);
    return ended;
  } catch {
    return false;
  }
}

export function setBrowserToken(token: string | null, ended = false) {
  try {
    if (token) localStorage.setItem(sessionKey, token);
    else localStorage.removeItem(sessionKey);
    if (ended) sessionStorage.setItem(endedKey, '1');
  } catch {
    // Without storage the person signs in again on the next load.
  }
  window.dispatchEvent(new CustomEvent('forkcast-browser-session'));
}

const unreachable =
  'Forkcast could not reach its server, so nothing was saved. Check the connection and try again.';

export async function serverRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  token: string | null = browserToken(),
  timeoutMs = 15_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CoreError(unreachable, 'unavailable');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      message?: string;
      fields?: CoreError['fields'];
    } | null;
    const kind: ErrorKind =
      (
        {
          401: 'unauthenticated',
          403: 'forbidden',
          404: 'not_found',
          409: 'conflict',
          422: 'invalid',
          412: 'connection_required',
          426: 'protocol_mismatch',
          429: 'rate_limited',
        } as Record<number, ErrorKind>
      )[response.status] ?? 'internal';
    if (response.status === 401 && token) setBrowserToken(null, true);
    throw new CoreError(
      error?.message ?? 'The server could not complete this request.',
      kind,
      error?.fields,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

/** Runs one operation of the shared application interface. */
export async function execute<T = unknown>(
  operation: string,
  args: object = {},
  timeoutMs?: number,
): Promise<T> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return (await invoke('execute', {
        operation: { operation, ...args },
      })) as T;
    } catch (failure) {
      throw asCoreError(failure);
    }
  }
  return serverRequest<T>(
    '/operations',
    'POST',
    { operation, ...args },
    browserToken(),
    timeoutMs,
  );
}

type Listener = (change: CoreChange) => void;
const listeners = new Set<Listener>();
let stopRelay: (() => void) | undefined;

function startRelay() {
  if (stopRelay) return;
  let stopped = false;
  let unlisten: (() => void) | undefined;
  const dispatch = (change: CoreChange) =>
    listeners.forEach((listener) => listener(change));
  if (isNative) {
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<CoreChange>('core-change', (event) =>
        dispatch(event.payload),
      );
      if (stopped) stop();
      else unlisten = stop;
    });
  } else {
    // Server-sent events carry the bearer header, which EventSource cannot.
    void (async () => {
      while (!stopped) {
        const token = browserToken();
        if (token) {
          try {
            const response = await fetch('/api/changes', {
              headers: { Authorization: `Bearer ${token}` },
              cache: 'no-store',
            });
            if (response.ok && response.body) {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              while (!stopped) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                  const block = buffer.slice(0, end);
                  buffer = buffer.slice(end + 2);
                  const data = block
                    .split('\n')
                    .find((line) => line.startsWith('data:'));
                  if (block.includes('event: change') && data)
                    dispatch(JSON.parse(data.slice(5)) as CoreChange);
                }
              }
            }
          } catch {
            // Reconnect below; every screen also reloads on focus.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    })();
  }
  stopRelay = () => {
    stopped = true;
    unlisten?.();
    stopRelay = undefined;
  };
}

/** Calls `listener` after a committed change to any of `topics`. */
export function subscribeToTopics(
  topics: Topic[],
  listener: (change: CoreChange) => void,
): () => void {
  const wrapped: Listener = (change) => {
    if (topics.includes(change.topic)) listener(change);
  };
  listeners.add(wrapped);
  startRelay();
  const refocus = () =>
    listener({ scope: { kind: 'person', id: '' }, topic: topics[0]! });
  // A browser tab that was hidden may have missed events.
  const visible = () => {
    if (!isNative && document.visibilityState === 'visible') refocus();
  };
  document.addEventListener('visibilitychange', visible);
  return () => {
    listeners.delete(wrapped);
    document.removeEventListener('visibilitychange', visible);
    if (!listeners.size) stopRelay?.();
  };
}

export interface HostStatus {
  state: 'ready' | 'failed';
  message?: string | null;
  dataDirectory?: string;
  version?: string;
  platform?: string;
}

export async function hostStatus(): Promise<HostStatus> {
  if (!isNative) return { state: 'ready' };
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke('host_status')) as HostStatus;
}

export async function retryStartup(): Promise<HostStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke('retry_startup')) as HostStatus;
}

export async function openDataFolder(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_data_folder');
}

/** Opens a web address in the person's own browser (a new tab on the web). */
export async function openExternal(url: string): Promise<void> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external', { url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** Hands a generated file to the platform: a save dialog in the app, a download in a browser. */
export async function saveFile(
  name: string,
  data: Uint8Array,
  type: string,
): Promise<string | null> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke('save_file', {
      suggestedName: name,
      data: Array.from(data),
      open: true,
    })) as string | null;
  }
  const url = URL.createObjectURL(new Blob([data.slice().buffer], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
