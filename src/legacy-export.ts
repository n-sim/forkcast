// Read-only exporter for the browser profile that Forkcast used before the
// installed app. It reads this origin's IndexedDB and localStorage, builds an
// explicit transfer file (format version 1), and offers it as a download. It
// never writes to or deletes the browser's data, and never includes session
// tokens or AI credentials. Remove it once the migration window has closed.
import './styles.css';

const FORMAT = 'forkcast-browser-transfer';
const VERSION = 1;
const DATABASE = 'forkcast';

type Row = Record<string, unknown>;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    // Opening without a version never upgrades or creates stores.
    const request = indexedDB.open(DATABASE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function exists(): Promise<boolean> {
  if (!indexedDB.databases) return true;
  return (await indexedDB.databases()).some((db) => db.name === DATABASE);
}

function all(db: IDBDatabase, store: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const request = db
      .transaction(store, 'readonly')
      .objectStore(store)
      .getAll();
    request.onsuccess = () => resolve(request.result as Row[]);
    request.onerror = () => reject(request.error);
  });
}

function settings(db: IDBDatabase): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, unknown>();
    if (!db.objectStoreNames.contains('localSettings')) return resolve(found);
    const request = db
      .transaction('localSettings', 'readonly')
      .objectStore('localSettings')
      .openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(found);
      found.set(JSON.stringify(cursor.key), cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

async function encode(
  blob: unknown,
): Promise<{ mime: string; data: string } | null> {
  if (!(blob instanceof Blob)) return null;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { mime: blob.type, data };
}

function stored(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function buildTransfer(): Promise<Row> {
  if (!(await exists()))
    throw new Error('This browser has no Forkcast data to transfer.');
  const db = await open();
  if (!db) throw new Error('Browser storage is not available.');
  try {
    if (!db.objectStoreNames.contains('recipes'))
      throw new Error('This browser has no Forkcast data to transfer.');
    const [
      recipes,
      photos,
      versions,
      revisions,
      ratings,
      ratingChanges,
      cookings,
      lists,
      sessions,
      manual,
      logged,
      localSettings,
    ] = await Promise.all([
      all(db, 'recipes'),
      all(db, 'recipeCoverPhotos'),
      all(db, 'nutritionVersions'),
      all(db, 'recipeRevisions'),
      all(db, 'personalRecipeRatings'),
      all(db, 'ratingChanges'),
      all(db, 'plannedCookings'),
      all(db, 'shoppingLists'),
      all(db, 'cookingSessions'),
      all(db, 'manualFoodLogEntries'),
      all(db, 'recipeFoodLogEntries'),
      settings(db),
    ]);
    const setting = (...key: unknown[]) =>
      localSettings.get(JSON.stringify(key.length === 1 ? key[0] : key));
    const foodLogDates: Record<string, string> = {};
    const shoppingListIds: Record<string, string> = {};
    for (const [text, value] of localSettings) {
      const key = JSON.parse(text) as unknown;
      if (Array.isArray(key) && typeof value === 'string') {
        if (key[0] === 'foodLogDate') foodLogDates[String(key[1])] = value;
        if (key[0] === 'shoppingListId')
          shoppingListIds[String(key[1])] = value;
      }
    }
    const aiPrompts: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const prefix = 'forkcast-ai-prompts:';
      if (key?.startsWith(prefix))
        aiPrompts[key.slice(prefix.length)] = localStorage.getItem(key) ?? '';
    }
    const backend = stored('forkcast-backend') as Row | null;
    return {
      format: FORMAT,
      version: VERSION,
      exportId: crypto.randomUUID(),
      exportedAt: new Date().toISOString(),
      source: { origin: location.origin },
      localPersonId: setting('personId') ?? null,
      recipes,
      coverPhotos: await Promise.all(
        photos.map(async (photo) => ({
          recipeId: photo.recipeId,
          ...(await encode(photo.image)),
        })),
      ),
      nutritionVersions: versions,
      recipeRevisions: await Promise.all(
        revisions.map(async (revision) => ({
          id: revision.id,
          parentId: revision.parentId ?? null,
          recipe: revision.recipe,
          nutritionVersions: revision.nutritionVersions ?? [],
          coverPhoto: await encode(revision.coverPhoto),
          pending: Boolean(revision.pending),
        })),
      ),
      ratings,
      ratingChanges,
      plannedCookings: cookings,
      shoppingLists: lists,
      cookingSessions: sessions,
      manualFoodLogEntries: manual,
      recipeFoodLogEntries: logged,
      settings: {
        foodLogDates,
        shoppingListIds,
        recipeSyncBinding: setting('recipeSyncBinding') ?? null,
        recipeSyncCurrent: setting('recipeSyncCurrent') ?? [],
        planningSync: setting('householdPlanningSync') ?? null,
      },
      aiPrompts,
      // The connection is identified, never authenticated: no token is exported.
      backend: backend
        ? {
            url: backend.url,
            accountId: backend.accountId ?? null,
            householdId: backend.householdId ?? null,
          }
        : null,
    };
  } finally {
    db.close();
  }
}

function render() {
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <main class="startup-error browser-gate" id="main-content">
      <h1>Move your Forkcast data to the app</h1>
      <p>
        Create a transfer file from the recipes, plans, shopping lists, cooking
        progress, food logs, and settings stored in this browser. Then choose
        that file in the Forkcast desktop app under Settings.
      </p>
      <ul>
        <li>Nothing is deleted or changed in this browser.</li>
        <li>The file contains your data but never sign-in sessions or ChatGPT credentials.</li>
        <li>You can create and import the file again safely.</li>
      </ul>
      <button class="button primary" id="export">Create transfer file</button>
      <p id="status" role="status"></p>
      <p id="problem" role="alert" class="error-banner" hidden></p>
    </main>`;
  const status = document.getElementById('status')!;
  const problem = document.getElementById('problem')!;
  document.getElementById('export')!.addEventListener('click', () => {
    problem.hidden = true;
    status.textContent = 'Reading this browser’s data…';
    buildTransfer()
      .then((transfer) => {
        const bytes = new Blob([JSON.stringify(transfer)], {
          type: 'application/json',
        });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(bytes);
        link.download = `forkcast-browser-transfer-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        status.textContent = `Transfer file created: ${(transfer.recipes as Row[]).length} recipes. Your browser data was not changed.`;
      })
      .catch((failure: unknown) => {
        status.textContent = '';
        problem.hidden = false;
        problem.textContent =
          failure instanceof Error
            ? failure.message
            : 'The transfer file could not be created.';
      });
  });
}

if (typeof document !== 'undefined' && document.getElementById('root'))
  render();
