# Forkcast

A local-first recipe collection with resumable guided cooking and a personal food
log. Create recipes and record intake without an account, application backend, or
AI connection. The interface is English with metric defaults.

## Run locally

Install Node.js 20.19+ or 22.12+ and a current stable Rust toolchain, then:

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

Open the local URL printed by Vite. `wasm-pack` is installed as a project development
dependency; the first build also downloads the matching `wasm-bindgen` tool.

For a production build:

```sh
npm run build
npm run preview
```

Deploy `dist/` to a static host over HTTPS (or serve it on localhost). Standalone use
needs no application server. Hash URLs let recipe links reopen on static hosts
without route rewrites. Keep the same origin to retain access to this device's data.

## Optional self-hosted backend and accounts

In a separate terminal, run:

```sh
npm run backend:dev
```

The Rust backend listens at `http://127.0.0.1:8787` and creates `forkcast.sqlite3`
in the working directory. SQLite is bundled; no database server is needed. Use
**Settings** at the bottom of the sidebar, then use its **Backend & accounts** section
to enter that URL and choose **Connect backend**.
An empty instance offers **Set up your household**: enter a household name, username,
and password to create its administrator. Each instance has one household. Setup
is atomic: concurrent requests cannot create another administrator or household.
Complete initial setup before making a new instance available to others.

The administrator creates local member accounts with **Create household account**
and shares their credentials and backend URL directly. No email or external identity
provider is involved. Usernames use 3–32 ASCII letters, numbers, dots, underscores,
or hyphens and are case insensitive; passwords use 12–128 characters. The administrator
can disable or re-enable members and reset their passwords. Disabling or resetting
ends all sessions for that member. This interface cannot disable or reset the
instance administrator.

Connection and authenticated account state appear in the top bar and are rechecked
every 30 seconds, when the application regains focus, and when connectivity changes. Sessions survive
browser and backend restarts, expire after 30 days, and are revoked by **Sign out**.
Passwords use salted Argon2id hashes; SQLite stores only hashes of random bearer
session tokens. The browser stores the connection URL and bearer token in its local
storage, never the password. Five failed sign-ins for a username temporarily block
further attempts for one minute; this survives backend restarts. API responses are
marked `no-store` and are not added to the offline cache.

Connecting, signing out, switching accounts, or disconnecting does not upload,
merge, or replace standalone recipes, photos, ratings, or cooking sessions. They
continue to use the existing local person identity and IndexedDB, independently
of the backend account. The account page explains this boundary. Backend outages
do not prevent local workflows or offline reopening. **Disconnect backend** forgets
the browser's connection; when a backend is unavailable, an existing server session
expires normally. Use **Sign out** while connected to revoke it immediately.
Record synchronization and backups are subsequent work.

For a release binary, run `npm run backend:build`, then run
`target/release/forkcast-backend` (`.exe` on Windows). Configuration uses environment
variables:

| Variable                   | Default                                       | Purpose                                                 |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `FORKCAST_BIND`            | `127.0.0.1:8787`                              | Listening address and port                              |
| `FORKCAST_DATABASE`        | `forkcast.sqlite3`                            | Persistent SQLite file; its parent directory must exist |
| `FORKCAST_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://127.0.0.1:4173` | Comma-separated frontend origins allowed by CORS        |

For remote access, put the backend behind an HTTPS reverse proxy and set the allowed
origin to the frontend's exact origin (scheme, hostname, and port). The frontend
accepts HTTPS backend URLs and HTTP on localhost only. The API uses `/api/` paths;
a proxy can expose it under a URL prefix if it strips that prefix before forwarding.
Keep the SQLite file on persistent storage and restrict filesystem access to the
backend service account.

The authenticated session supplies the account and household identities. Shared
records must authorize their stored household owner; personal records must authorize
their stored account owner, including when the caller is the administrator. The
Rust `Authenticated::require` boundary implements both scopes. The initial API proves
them through `GET /api/households/{id}` and `GET /api/accounts/{id}`; the latter permits
only the account itself. Separate administrator-only `GET/POST /api/accounts` and
`PATCH /api/accounts/{id}` operations manage safe account metadata and credentials,
without granting access to another person's records. Subsequent synchronization
endpoints must apply these same owner checks. Client-supplied roles or household
identities are not accepted when creating accounts.

## Data and offline use

Recipes are stored in this browser's IndexedDB. Each recipe, ingredient, and cooking
step has a stable identity. Saving an edit updates that recipe after the database
transaction completes. Active time means dedicated work or attention; total time
means elapsed preparation time until the dish is ready. Difficulty and times may be
left unspecified.

In the recipe editor, use **Allocate ingredient** on a cooking step to assign an
amount from a recipe ingredient total. Split an ingredient across steps as needed.
**Allocation checks** appear only in the editor and show missing or excess amounts,
including ingredients with no allocations. These warnings allow a recipe to be
saved for later correction; invalid amounts, duplicate ingredients within a step,
and incompatible units must be corrected before saving. Removing an ingredient removes its allocations;
reordering steps keeps their allocations attached. Instructions never supply or
change the structured ingredient totals. Recipes saved before allocations were
introduced open with empty allocations and show their unallocated amounts in the
editor.

In the recipe view, change **Cooking portions** to scale both ingredient totals
and step allocations, including fractional portions. This is a viewing choice;
it does not edit the recipe's base yield or saved quantities. **Display units**
defaults to useful metric units and also offers **US customary** and **As entered**.
Display choices reset when reopening the recipe. Supported mass units are mg, g,
kg, avoirdupois oz, and lb; volume units are ml, l, US tsp, US tbsp, US fl oz,
and US cup. Pieces scale without changing dimension. No density or AI conversion
is assumed between mass, volume, and pieces.

Conversions use fixed definitions: 1 lb = 453.59237 g, 16 oz = 1 lb,
1 US cup = 236.5882365 ml, 8 US fl oz = 1 US cup, 16 US tbsp = 1 US cup,
and 3 US tsp = 1 US tbsp. These are US customary measures, distinct from metric,
imperial, or nutrition-label cup and spoon measures; see
[NIST's conversion tables](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9).
Calculations retain floating point precision, with a relative tolerance of one
part in a billion for allocation checks. Displayed fractional amounts are truncated
to two decimal places; amounts below 0.01 retain up to two significant digits so
small quantities remain visible. Quantities outside the calculation range show an error.

Choose **Cooking portions** and **Display units**, then **Start cooking** to capture
that recipe, scale, and unit preference for a cooking session. The session keeps its
display units when resumed, independently of later choices in the recipe view.
**Next step** and **Back step** show each captured
instruction with its scaled ingredient allocations. Progress saves locally before
the next step opens. **Suspend cooking** saves progress and returns to the recipe.
A fixed bottom bar shows the suspended recipe, portions, and step progress in the
collection, recipe, and recipe editor views. **Resume cooking** in that bar returns
to the saved step, including after reopening offline. The bar stays clear of editor
controls and disappears while following cooking steps. Each person can have one unfinished cooking
session across all recipes. Starting another offers **Keep current session** or
**Cancel current and start cooking**; keeping it leaves its progress untouched.
Replacement cancels the previous session and captures the new recipe in one saved
operation, including when different tabs try to start cooking together.
Recipe edits, including edits in
another tab, show a changed-recipe notice in an existing session while its
captured ingredients, instructions, order, and scale stay unchanged.
On the last step, **Finish cooking** saves completion and returns to the recipe.
**Cancel cooking**, next to **Suspend cooking**, asks for confirmation before
ending the session without marking it finished or the recipe cooked. Choose
**Keep cooking** or press Escape to return without changing its progress or timers.
Finished and canceled sessions no longer appear in the resume links, including
after reopening. Their saved records remain distinct for later cooking-history work.
Sessions and their start/replacement checks belong to the current person;
sharing recipes does not share cooking progress or prevent another person cooking.

Each step offers a timer with a duration in minutes, including fractional minutes.
Timers run independently across steps. **Pause timer** holds the remaining time,
**Resume timer** continues it, and **Reset timer** restores the original duration
in a paused state. Running timers retain a deadline, so closing the view or
application does not restart their countdown; reopening shows the remaining time
or that they finished. Paused timers remain paused after reopening. Finished timers
are announced visibly in the cooking view, including timers from other steps.
No alarms are provided while the application is closed or suspended.
Cooking sessions do not create food-log entries or track leftover portions.

Open **Food log** in the sidebar and choose a **Food log date** to see that day's
intake. **Add manual entry** records a food description, consumption date/time,
and calories (kcal), protein, fat, and carbohydrates (g) for the amount eaten.
The entry appears on its consumption day, even if added while viewing another
day. Consumption dates and times retain the entered local calendar values rather
than moving between days when a device's timezone changes.

Leave each unknown nutrient blank; enter zero only when it is known to be zero.
Daily nutrition sums the known values separately for each nutrient. Incomplete
totals identify how many entries have unknown values; a nutrient with no known
values displays **Unknown**. Entries, unknown values, and the last selected daily
view persist locally and work offline. Manual entries belong to the persistent
local person identity and have their own nutrition, independently of recipes,
plans, and cooking sessions. They do not create reusable foods in a catalog.
Recipe-linked entries and dated nutrition goals are subsequent additions.

Open a recipe to attach or replace its cover photo (JPEG, PNG, or WebP, up to
10 MB), or remove it with **Remove cover photo**. Photos save automatically and
appear in both the recipe view and collection, including offline. Replacing or
removing a photo keeps the recipe and its contents.

Use **Your rating** and **Save rating** to record a personal score from 1 to 5.
Choose **Not rated** and save to clear it. The collection shows your saved score;
leaving without saving keeps the previous rating. Ratings do not change the
recipe’s shared difficulty, active time, or total time.

Cover photos are stored as household recipe assets keyed by recipe identity.
Ratings are separate personal records keyed by a persistent local person identity
and recipe identity. Standalone mode has one local person without login; a later
synchronization slice can explicitly map that identity to an account. Existing recipe collections
upgrade in place without discarding recipes.
Cooking sessions and manual food-log entries are separate personal records
belonging to that local identity; upgrading storage preserves the identity,
recipes, cover photos, ratings, and cooking sessions.

The production build caches the application and WebAssembly assets using a service
worker. After the first online visit and cache installation, it can reopen offline.
The development server does not install an offline cache. Manual recipe and
food-log actions do not contact external services.

Browser data belongs to the browser profile and origin. Clearing site data removes
recipes, photos, ratings, cooking sessions, and the food log; private browsing may discard them when the session ends. Cross-device
synchronization and backups are subsequent additions to the optional backend.

## Development and verification

```sh
npx playwright install chromium
npm run wasm:build
npm run typecheck
npm run check:rust
npm test
```

The Playwright suite builds and serves the production application, including the
actual Rust/WebAssembly module and offline cache. It exercises visible workflows
with real IndexedDB in isolated browser contexts at desktop and tablet sizes.
Account workflows start a real Rust backend with a fresh temporary SQLite database
per test and clean up the process and files afterward. They cover setup, separate
devices, administration, reload/restart, invalid credentials, and preservation of
standalone records while disconnected or offline. Focused HTTP tests cover ownership,
unauthorized requests, session revocation, setup races, and sign-in throttling. No
external provider credentials or network-service fixtures are needed.
To run one workflow:

```sh
npm test -- tests/recipes.spec.ts --project=desktop --grep "create a recipe"
```

`npm run typecheck` checks application, build configuration, and browser tests. Run
`npm run wasm:build` first after cloning or modifying the Rust export interface.
Rust changes need a new WebAssembly build; restart `npm run dev` or build it again.

## Layout

- `src/`: React screens, typed WebAssembly boundary, and local recipe storage.
- `crates/recipe-domain/`: Rust recipe types, normalization, validation, scaling, conversions, and step timers, also
  usable by native Rust code. Generated WebAssembly is not committed.
- `crates/backend/`: optional Rust HTTP service, SQLite accounts, authentication, and ownership boundaries.
- `tests/`: browser workflow specifications, the confirmed main testing seam.
- `docs/adr/` and `GLOSSARY.md`: accepted decisions and domain vocabulary.

The application implements standalone recipes ([issue #2](https://github.com/n-sim/forkcast/issues/2))
and recipe cover photos and personal ratings ([issue #3](https://github.com/n-sim/forkcast/issues/3)),
plus ingredient scaling, allocations, and compatible conversions
([issue #4](https://github.com/n-sim/forkcast/issues/4)) and resumable guided cooking
with foreground timers ([issue #9](https://github.com/n-sim/forkcast/issues/9)) and optional
backend household accounts ([issue #22](https://github.com/n-sim/forkcast/issues/22)).
Planning, cooking history, nutrition, AI, record synchronization, and backups are later work.
