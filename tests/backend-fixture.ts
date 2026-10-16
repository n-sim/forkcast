import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const test = base.extend<{
  backend: {
    url: string;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
  };
}>({
  backend: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'forkcast-backend-'));
    let process: ChildProcess;
    let url = '';
    async function start() {
      process = spawn(
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
            FORKCAST_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      url = await new Promise<string>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(
          () => reject(new Error(`Backend did not start: ${errors}`)),
          15_000,
        );
        process.stderr!.on('data', (data: Buffer) => {
          errors += data.toString();
        });
        process.stdout!.on('data', (data: Buffer) => {
          output += data.toString();
          const match = output.match(/listening on (http:\/\/[^\s]+)/);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolve(match[1]);
          }
        });
        process.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        process.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Backend exited (${code}): ${errors}`));
        });
      });
    }
    async function stop() {
      if (process && process.exitCode === null && process.signalCode === null) {
        const exited = once(process, 'exit');
        process.kill();
        await exited;
      }
    }
    try {
      await start();
      await use({
        get url() {
          return url;
        },
        stop,
        restart: async () => {
          await stop();
          await start();
        },
      });
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
export { expect };
