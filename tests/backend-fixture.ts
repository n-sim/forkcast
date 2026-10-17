import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect } from './app-fixture';

export interface Backend {
  readonly url: string;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  /** Stops the server for good and removes its database. */
  dispose: () => Promise<void>;
}

/**
 * A real household server over a real SQLite database. It serves the built
 * frontend, so browsers can use it, and installed apps can join it.
 */
export async function startBackend(
  env: Record<string, string> = {},
): Promise<Backend> {
  const directory = await mkdtemp(join(tmpdir(), 'forkcast-backend-'));
  let child: ChildProcess;
  let url = '';
  async function start() {
    child = spawn(
      resolve(
        'target/debug/forkcast-backend' +
          (globalThis.process.platform === 'win32' ? '.exe' : ''),
      ),
      [],
      {
        env: {
          ...globalThis.process.env,
          FORKCAST_BIND: url ? new URL(url).host : '127.0.0.1:0',
          FORKCAST_DATABASE: join(directory, 'household.sqlite3'),
          FORKCAST_STATIC_DIR: resolve('dist'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    url = await new Promise<string>((resolveUrl, reject) => {
      let output = '';
      let errors = '';
      const timeout = setTimeout(
        () => reject(new Error(`Backend did not start: ${errors}`)),
        15_000,
      );
      child.stderr!.on('data', (data: Buffer) => {
        errors += data.toString();
      });
      child.stdout!.on('data', (data: Buffer) => {
        output += data.toString();
        const match = output.match(/listening on (http:\/\/[^\s]+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolveUrl(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Backend exited (${code}): ${errors}`));
      });
    });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  await start();
  return {
    get url() {
      return url;
    },
    stop,
    restart: async () => {
      await stop();
      await start();
    },
    dispose: async () => {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const backend = await startBackend();
    try {
      await use(backend);
    } finally {
      await backend.dispose();
    }
  },
});
export { expect };
