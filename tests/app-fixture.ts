import {
  chromium,
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Journeys run against the real packaged desktop app: its WebView2 window is
// driven over the DevTools protocol, and its embedded core stores real SQLite
// in an isolated data directory. A restart is a real process restart.

const binary = () =>
  process.env.FORKCAST_APP_BINARY ??
  resolve(
    'target/debug/forkcast-desktop' +
      (process.platform === 'win32' ? '.exe' : ''),
  );

export interface AppOptions {
  /** Reuse a profile to simulate reopening the app. */
  profile?: string;
  env?: Record<string, string>;
  viewport?: { width: number; height: number };
  /** Time zone the web view should report, as Playwright's `timezoneId`. */
  timezoneId?: string;
}

export interface App {
  /** Addresses the app asked to open in the person's own browser. */
  externalUrls(): Promise<string[]>;
  page: Page;
  context: BrowserContext;
  /** Waits for the app to deliver a saved file (such as the shopping PDF). */
  delivered(): Promise<{ name: string; path: string }>;
  /** Opens a second window of the same app: one core, two views. */
  newWindow(): Promise<Page>;
  /** The profile directory holding this app's data, WebView storage and saved files. */
  profile: string;
  /** Where files the app saves (PDFs) are delivered during automation. */
  files: string;
  /** Closes the app and opens it again on the same data. */
  restart(options?: Pick<AppOptions, 'env'>): Promise<Page>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForDebugger(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Forkcast exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error('Forkcast did not open its window in time.');
}

function kill(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

export async function launchApp(options: AppOptions = {}): Promise<App> {
  const profile =
    options.profile ?? (await mkdtemp(join(tmpdir(), 'forkcast-app-')));
  const files = join(profile, 'files');
  await mkdir(files, { recursive: true });
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let current: Page;
  let context: BrowserContext;

  async function open(env: Record<string, string> = {}) {
    // A relaunch can start before WebView2 has released the profile, which
    // ends the app at startup; that is the runner being slow, so try again.
    let port = 0;
    for (let attempt = 1; ; attempt++) {
      port = await freePort();
      child = spawn(binary(), [], {
        env: {
          ...process.env,
          FORKCAST_DATA_DIR: join(profile, 'data'),
          FORKCAST_SAVE_DIRECTORY: files,
          FORKCAST_EXTERNAL_URL_FILE: join(profile, 'external-urls.txt'),
          WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
          ...options.env,
          ...env,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: false,
      });
      let errors = '';
      child.stderr?.on('data', (chunk) => {
        errors = (errors + chunk).slice(-2000);
      });
      try {
        await waitForDebugger(port, child);
        break;
      } catch (failure) {
        kill(child);
        if (attempt >= 3 || child.exitCode === null)
          throw new Error(`${(failure as Error).message}
${errors}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    context = browser.contexts()[0]!;
    const deadline = Date.now() + 15_000;
    let found: Page | undefined;
    while (!found && Date.now() < deadline) {
      found = context
        .pages()
        .find((page) => page.url().includes('tauri.localhost'));
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    if (!found) throw new Error('The Forkcast window did not load.');
    current = found;
    await current.waitForLoadState('domcontentloaded');
    if (options.viewport) await current.setViewportSize(options.viewport);
    current = adopt(current);
    await emulate(current);
    app.page = current;
    app.context = context;
  }

  async function close() {
    await browser?.close().catch(() => undefined);
    if (child) kill(child);
    child = undefined;
    // WebView2 releases its profile a moment after the process ends.
    await new Promise((r) => setTimeout(r, 400));
  }

  async function emulate(page: Page) {
    if (!options.timezoneId) return;
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', {
      timezoneId: options.timezoneId,
    });
  }

  // The packaged app's origin; specs navigate with paths, as they always did.
  function adopt(page: Page): Page {
    const goto = page.goto.bind(page);
    page.goto = (url, gotoOptions) =>
      goto(new URL(url, 'http://tauri.localhost/').href, gotoOptions);
    return page;
  }

  const app: App = {
    async delivered() {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const names = (await readdir(files)).filter(
          (name) => !name.endsWith('.tmp'),
        );
        if (names.length) {
          const name = names.sort().at(-1)!;
          return { name, path: join(files, name) };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('The app did not deliver a file.');
    },
    async newWindow() {
      const known = new Set(context.pages());
      await app.page.evaluate(() =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke('open_window'),
      );
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const found = context
          .pages()
          .find(
            (page) =>
              !known.has(page) && page.url().includes('tauri.localhost'),
          );
        if (found) {
          await found.waitForLoadState('domcontentloaded');
          if (options.viewport) await found.setViewportSize(options.viewport);
          await emulate(found);
          return adopt(found);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('The second Forkcast window did not open.');
    },
    page: undefined as unknown as Page,
    context: undefined as unknown as BrowserContext,
    profile,
    files,
    async externalUrls() {
      const text = await readFile(
        join(profile, 'external-urls.txt'),
        'utf8',
      ).catch(() => '');
      return text
        .split(String.fromCharCode(10))
        .map((line) => line.trim())
        .filter(Boolean);
    },
    async restart(restartOptions) {
      await close();
      await open(restartOptions?.env);
      return app.page;
    },
    async stop() {
      await close();
      if (!options.profile)
        await rm(profile, { recursive: true, force: true }).catch(
          () => undefined,
        );
    },
  };
  await open();
  return app;
}

export const test = base.extend<{
  launch: (options?: AppOptions) => Promise<App>;
  app: App;
  /** A plain browser page standing in for the person's own browser. */
  systemBrowser: () => Promise<Page>;
}>({
  systemBrowser: async ({}, use) => {
    const browser = await chromium.launch();
    await use(async () => (await browser.newContext()).newPage());
    await browser.close();
  },
  launch: async ({ timezoneId }, use, testInfo) => {
    const apps: App[] = [];
    const viewport = testInfo.project.use.viewport ?? {
      width: 1280,
      height: 720,
    };
    await use(async (options) => {
      const app = await launchApp({ viewport, timezoneId, ...options });
      apps.push(app);
      return app;
    });
    for (const app of apps.reverse()) await app.stop();
  },
  app: async ({ launch }, use) => {
    await use(await launch());
  },
  // Specs use `page` and `context` as before; they are now the packaged app.
  page: async ({ app }, use) => {
    await use(app.page);
  },
  context: async ({ app }, use) => {
    await use(app.context);
  },
});

export * from '@playwright/test';

/**
 * Runs `trigger`, which asks the app to open a web address in the person's own
 * browser, and returns a plain browser page at that address.
 */
export async function openedExternally(
  app: App,
  systemBrowser: () => Promise<Page>,
  trigger: () => Promise<void>,
): Promise<Page> {
  const before = (await app.externalUrls()).length;
  await trigger();
  await expect
    .poll(async () => (await app.externalUrls()).length)
    .toBeGreaterThan(before);
  const page = await systemBrowser();
  await page.goto((await app.externalUrls()).at(-1)!);
  return page;
}

/**
 * A browser-profile transfer (see docs/browser-transfer.md) with defaults, for
 * journeys that start from data made by an earlier release.
 */
export function legacyTransfer(data: Record<string, unknown> = {}) {
  return {
    format: 'forkcast-browser-transfer',
    version: 1,
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    source: { origin: 'https://forkcast.example' },
    localPersonId: 'existing-person',
    recipes: [],
    coverPhotos: [],
    nutritionVersions: [],
    recipeRevisions: [],
    ratings: [],
    ratingChanges: [],
    plannedCookings: [],
    shoppingLists: [],
    cookingSessions: [],
    manualFoodLogEntries: [],
    recipeFoodLogEntries: [],
    settings: {
      foodLogDates: {},
      shoppingListIds: {},
      recipeSyncBinding: null,
      recipeSyncCurrent: [],
      planningSync: null,
    },
    aiPrompts: {},
    backend: null,
    ...data,
  };
}

/** Imports a transfer through the app's own screen, as a person would. */
export async function importTransfer(page: Page, transfer: object) {
  await page.goto('/#/settings');
  await page.getByLabel('Browser transfer file').setInputFiles({
    name: 'forkcast-browser-transfer.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(transfer)),
  });
  await expect(
    page.getByRole('status', { name: 'Browser data import' }),
  ).toContainText(/Imported|already imported/);
}
