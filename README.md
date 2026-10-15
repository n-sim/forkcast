# Forkcast

A local-first recipe collection with resumable guided cooking. Create, view, and edit recipes without an account,
application backend, or AI connection. The interface is English with metric defaults.

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

Deploy `dist/` to a static host over HTTPS (or serve it on localhost). There is no
application server to configure. Hash URLs let recipe links reopen on static hosts
without route rewrites. Keep the same origin to retain access to this device's data.

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

Choose **Cooking portions**, then **Start cooking** to capture that recipe and
scale for a cooking session. **Next step** and **Back step** show each captured
instruction with its scaled ingredient allocations. Progress saves locally before
the next step opens. **Close cooking** returns to the recipe; **Resume cooking**
there or a session's **Resume** link in the collection returns to the saved step,
including after reopening offline. Starting another session captures the current
recipe without replacing an earlier session. Recipe edits, including edits in
another tab, show a changed-recipe notice in an existing session while its
captured ingredients, instructions, order, and scale stay unchanged.

Each step offers a timer with a duration in minutes, including fractional minutes.
Timers run independently across steps. **Pause timer** holds the remaining time,
**Resume timer** continues it, and **Reset timer** restores the original duration
in a paused state. Running timers retain a deadline, so closing the view or
application does not restart their countdown; reopening shows the remaining time
or that they finished. Paused timers remain paused after reopening. Finished timers
are announced visibly in the cooking view, including timers from other steps.
No alarms are provided while the application is closed or suspended.
Cooking sessions do not create food-log entries or track leftover portions.

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
account/sync slice can map that identity to an account. Existing recipe collections
upgrade in place without discarding recipes.
Cooking sessions are separate personal records belonging to that local identity;
upgrading storage preserves the identity, recipes, cover photos, and ratings.

The production build caches the application and WebAssembly assets using a service
worker. After the first online visit and cache installation, it can reopen offline.
The development server does not install an offline cache. Manual recipe actions do
not contact external services.

Browser data belongs to the browser profile and origin. Clearing site data removes
recipes, photos, ratings, and cooking sessions; private browsing may discard them when the session ends. Cross-device
synchronization and backups require the future optional backend.

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
with real IndexedDB in isolated browser contexts at desktop and tablet sizes. No
backend, provider credentials, or network-service fixtures are needed for this slice.
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
  usable by a future native Rust backend. Generated WebAssembly is not committed.
- `tests/`: browser workflow specifications, the confirmed main testing seam.
- `docs/adr/` and `GLOSSARY.md`: accepted decisions and domain vocabulary.

The application implements standalone recipes ([issue #2](https://github.com/n-sim/forkcast/issues/2))
and recipe cover photos and personal ratings ([issue #3](https://github.com/n-sim/forkcast/issues/3)),
plus ingredient scaling, allocations, and compatible conversions
([issue #4](https://github.com/n-sim/forkcast/issues/4)) and resumable guided cooking
with foreground timers ([issue #9](https://github.com/n-sim/forkcast/issues/9)).
Planning, cooking history, nutrition, AI, and backend synchronization are later work.
