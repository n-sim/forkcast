# Forkcast

A recipe collection with household cooking plans and shopping, resumable guided cooking, and a
personal food log. Create recipes, plan cooking, and record intake without an account, a server,
or an AI connection. The interface is English with metric defaults.

Forkcast is an **installed app** (desktop today, Android in preparation) built from one React
frontend and one Rust application core with SQLite. Households that want to share recipes, the
meal plan, and the shopping list add an optional **household server** that hosts the same core.
The installed app always reads and writes its own embedded core, so cooking, planning, shopping
checklists, and food logging keep working through server outages, expired sessions, and being
offline; pending changes are stored durably and deliver when the server returns. A **browser**
is an online client of the household server, with no offline mode and no database of its own.
See [ADR 0015](docs/adr/0015-embed-a-shared-rust-core-and-synchronize.md) and
[the product specification](https://github.com/n-sim/forkcast/issues/1).

| I want to…                                                              | Read                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| install and build the desktop app, understand where data lives, signing | [docs/desktop.md](docs/desktop.md)                   |
| run a household server (Docker, HTTPS, upgrades)                        | [docs/server.md](docs/server.md)                     |
| move data from the old browser version                                  | [docs/browser-transfer.md](docs/browser-transfer.md) |
| build for Android and see its release gates                             | [docs/android.md](docs/android.md)                   |
| use the core's operations, errors, and change notifications             | [docs/core-interface.md](docs/core-interface.md)     |

## Run locally

Install Node.js 20.19+ or 22.12+ and a current stable Rust toolchain (with the MSVC build tools on
Windows), then:

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run desktop:dev      # the app window with a Vite dev server
npm run desktop:build    # the installer (see docs/desktop.md)
```

`wasm-pack` is installed as a project development dependency; the first build also downloads the
matching `wasm-bindgen` tool. To try the browser experience against a local server:

```sh
npm run build
FORKCAST_STATIC_DIR=dist npm run backend:dev    # then open http://127.0.0.1:8787
```

The frontend has no service worker and no browser storage of its own. Packaged assets change only
with application releases.

## Optional local ChatGPT companion

For standalone ChatGPT subscription access, start the small native Rust companion
in a separate terminal:

```sh
npm run companion:dev
```

For an installable release binary, run `npm run companion:build` and use
`target/release/forkcast-ai-companion` (`.exe` on Windows). No synchronization
backend, SQLite database, backend account, or API key is needed.

Open **Settings → ChatGPT**, enter `http://127.0.0.1:8788`, and choose
**Connect companion**, then **Continue with ChatGPT**. Complete authorization in
your own browser, which Forkcast opens for you, and return to Settings to see the connected
account. The companion runs on the same device as the app.

The native listener is started before sign-in and receives the callback at
`http://127.0.0.1:8788/auth/callback`. It follows OpenAI's
[registration and sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
dynamic client registration, a stable `urn:uuid:<UUIDv4>` host identity, fresh state/nonce and S256
PKCE, exact callback matching during code exchange, and signed ID-token checks
against OpenAI's JWKS, issuer, issued-client audience, expiry, and nonce. ChatGPT
plan permission must be granted before the account is shown as connected.

Credentials persist only in the native runtime: `%LOCALAPPDATA%/Forkcast/ai/`
with Windows user-bound DPAPI encryption, or `~/.config/forkcast/ai/` with an
owner-only directory and atomically replaced `0600` files on Unix. The browser
remembers only the companion URL and receives connection state and account email.
Access, refresh, and ID tokens never enter browser storage, recipe records, sync
payloads, response bodies, or logs. A runtime lock prevents concurrent companions
from using the same credential directory. Keep that directory private; do not
commit it or serve it as static content.

Denied, incomplete, or failed authorization has a visible retry state. Closing
the sign-in window leaves a pending attempt that can be restarted and expires
after ten minutes. An expired session offers reconnection. **Sign out of ChatGPT**
clears local tokens and attempts remote session revocation; a warning explains
when revocation could not be confirmed. Reconnecting reuses the issued registration
and host identity. Initial companion versions saved an unsupported `forkcast:`
host ID; restarting the updated companion automatically replaces it with a
persisted UUID URI while retaining the saved account registration and credentials.
Manual workflows remain available when AI is unconfigured or
the companion is stopped. Recipes, plans, food logs, and cooking progress stay in
the frontend's existing local store; installing this companion adds no backups or
cross-device synchronization. Backend AI execution is separate work; recipe
generation currently uses the connected companion, including when recipe sync is enabled.

Choose **Generate recipe** in the recipe collection, include any dish-specific
instructions in **Describe your dish**, and select an available ChatGPT model.
**Settings → Personal AI prompts** stores editable recipe-generation system-prompt
defaults on this device, separately for standalone use and each backend account.
Defaults are applied to future requests; request-specific instructions are not
retained as defaults. Prompt synchronization and server-side execution come later.

Generation uses the documented [ChatGPT subscription inference flow](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
the native runtime lists models with its protected access token, calls the public
Responses API with `store: false` and `stream: true`, and waits for completed inference.
The browser then validates the result with the shared Rust/WebAssembly recipe and
quantity contracts, including complete ingredient allocations, before saving it
through normal local recipe storage. A successful recipe opens automatically and
can be edited or synchronized like a manually created recipe. Invalid recipes,
refusals, interrupted streams, provider errors, and failed saves remain visible;
they do not claim that a recipe was created.

Companion environment settings:

| Variable                      | Default                                       | Purpose                                                                                                  |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `FORKCAST_AI_BIND`            | `127.0.0.1:8788`                              | IPv4 loopback listener; non-loopback binds are rejected. The selected port is used for the callback too. |
| `FORKCAST_AI_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://127.0.0.1:4173` | Comma-separated exact frontend origins. Add your HTTPS static-host origin when needed; no wildcards.     |
| `FORKCAST_AI_DIRECTORY`       | Native path above                             | Private runtime credential directory, separate from application data.                                    |

Only allowed frontend origins with the companion request header can use its API.
Host checks also reject DNS rebinding. Callbacks require the one-time pending
state. Responses are `no-store`, callback pages do not load external resources,
and they send no referrer. Release builds always use OpenAI's issuer. Debug builds
alone accept `FORKCAST_AI_TEST_ISSUER` for an HTTP `127.0.0.1` authorization/inference fixture
with an explicitly isolated credential directory; stored credentials cannot be
reused with another issuer.

## Household server and synchronization

The household server hosts the same Rust core as the app, with HTTP, first-administrator setup,
and account administration (`npm run backend:dev`, or the Docker setup in
[docs/server.md](docs/server.md)). One instance has one household. An empty instance offers **Set
up your household**: a household name, and the administrator's username and password. Setup is
atomic: concurrent requests cannot create a second administrator or household. The administrator
creates member accounts under **Settings → Household accounts** and shares credentials directly;
no email or external identity provider is involved. Usernames use 3–32 ASCII letters, numbers,
dots, underscores, or hyphens (case insensitive); passwords use 12–128 characters. Disabling a
member or resetting their password ends all of their sessions. Passwords use salted Argon2id
hashes, the database stores only hashes of random bearer tokens, sessions last 30 days, and five
failed sign-ins for a username block further attempts for a minute (surviving restarts).

**Joining from the app.** In **Settings → Backend & accounts**, enter the server's address, then
set up or sign in. **Enable data synchronization** opens a review before anything is published or
replaced:

- choose which local recipes to contribute (recipes whose IDs the household already has join as
  competing alternatives and never overwrite each other; recipes you leave out stay on the device,
  hidden and unpublished);
- select planned cookings to add (possible duplicates are flagged) and keep the household shopping
  list or replace it with the device's;
- optionally move this device's ratings, food log, cooking sessions, and AI settings to the
  signed-in account — personal records never become household records.

**Continue with household data** replaces the device's meal plan and shopping list with the
household's (the explanation says so) and publishes nothing; **Cancel** changes neither side.

**Afterwards.** The app keeps reading and writing its embedded core. Every change commits together
with its pending synchronization work, and delivery retries after restart, on focus or resume, on
reconnect, and with **Sync now**; Settings shows pending work, errors, and completion. Independent
or identical edits combine, including different fields of the same planned cooking or shopping
item. Competing changes to one field, deletion versus editing, regeneration alternatives, and
competing recipe revisions are kept for explicit resolution (**Review planning conflicts**,
**Review recipe conflicts**); a choice made against alternatives that have since changed is
refused. Saving from an older view of the plan never overwrites newer changes.

**Accounts.** **Sign out** pauses synchronization and hides that account's private records;
household records stay usable and the account's pending changes stay with it. Another account of
the same household gets its own private records on the same device. **Disconnect backend** keeps
local records and the household link; rejoining the same household resumes. A different household
needs a separate local profile. Server session tokens live in protected storage (Windows DPAPI),
never in the synchronized data.

**Releases.** The app and server declare a synchronization protocol version; a mismatch is shown
in Settings and every pending change is kept.

Configuration, HTTPS, reverse proxies, and upgrades are in [docs/server.md](docs/server.md). The
authorization model and HTTP/native operations are in [docs/core-interface.md](docs/core-interface.md).

## Data and offline use

Recipes are stored by the application core in SQLite on this device. Each recipe, ingredient, and cooking
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
Dated nutrition goals are a subsequent addition.

In the recipe editor, enter **Recipe nutrition** as totals for the recipe's base
yield. Calories (kcal), protein, fat, and carbohydrates (g) can each be known or
left blank independently. Recipe views show whole-recipe and per-portion values;
planner cards show a brief per-portion overview when any nutrition is known.
Changing **Cooking portions** or planning more portions keeps this basis unchanged.

In **Food log**, choose **Log recipe portions**, select a recipe, and record
**Consumed at** and **Portions eaten**, including fractional portions. Each entry
retains its recipe identity, portion count, and nutrition-version reference. Daily
totals combine recipe and manual entries, sum known values, and identify unknowns.
These records persist on this device and remain available offline.

Every calorie or macro change creates a retained nutrition version. Changing a
recipe's base yield also creates a version: a 2,000 kcal recipe yielding four
portions has 500 kcal per portion; changing its yield to two gives new entries
1,000 kcal per portion while past entries keep 500 kcal. Ingredient-only edits
retain nutrition. Planning and cooking never create consumption entries or
change per-portion nutrition. Recipe names in the food log link to their current
recipe page. Entries using an older nutrition version show **Newer recipe nutrition
available**; following their link explains that the recipe now has newer nutrition
while the entry keeps its logged values. Explicitly updating an individual entry
to current nutrition is subsequent work.

Open **Meal plan** for a Monday–Sunday cooking schedule. Use **Previous week**,
**Next week**, **This week**, or **Week containing** to choose a period.
**Plan cooking** schedules a current recipe with a cooking date and positive portion
count, including fractional portions. Selecting a recipe defaults **Portions to cook**
to that recipe's **Base yield**. Override this to set the total quantity for everyone you are
feeding: four portions can provide dinner and the next day's lunch for two people.
Multiple entries can share a date and recipe; each can have its own optional cooking
time. **Edit planned cooking** changes that entry's recipe, date, portions,
or time. Opening an existing entry retains its saved portions; selecting a different
recipe defaults the quantity to that recipe's base yield. Saving in the weekly view opens the week containing the saved date;
**Cancel** leaves the saved entry unchanged.

Assign or clear **Label (optional)** in the recipe editor. The label belongs to the
shared recipe and appears in its collection card, recipe view, and every planned
cooking of that recipe. Editing the recipe label updates those views; planned
cookings do not have individual labels.

**Today** shows only today's scheduled cooking, with each recipe's current active
and total times and label, portions to cook, and optional cooking time. It updates when the
local date changes. Recipe links open current contents, and edits in another tab
refresh the displayed recipe information. Times left blank are identified as
unspecified. Dates and optional times keep their entered local calendar values.

Plans belong to the persistent local person, even when their portions feed other
household members. They save to the core, survive reopening offline, and remain
shared with the household once the device has joined one.
Scheduling creates no food-log entries, consumption times, or portion stock.
Cards show a per-portion recipe nutrition brief when at least one value is known,
otherwise **Recipe nutrition not available**. Daily intake totals remain in **Food log**.

Open **Shopping list**, set **Shopping from** and **Shopping through**, and choose
**Generate shopping list**. Both dates are included. Each planned cooking supplies
its recipe ingredient totals scaled to its portions, independently of step allocations
or food-log entries. Ingredient names match ignoring case and repeated whitespace;
compatible mass, volume, and piece quantities combine using the shared Rust conversions.
Mass, volume, and pieces remain separate when a density or piece weight is unknown,
with a **Review conversion** notice. Different ingredient names are not guessed to match.

Use **Save quantity** or **Remove item** to review generated requirements. Each item's
**From:** note links directly to its source recipes and retains the cooking dates and
planned portions captured when generated. **Add manual item**
adds extra food with its own quantity and unit under **Manual shopping items**;
matching manual and generated groceries stay independent.

The current shopping list saves a stable result locally. Recipe and plan edits do not
change its quantities or captured contributions. A source status indicates meal-plan
changes within the saved cooking period, including additions, removals, recipe changes,
portions, dates, and cooking times. Changes outside that period do not flag the list.
Ingredient names, amounts, units, additions, removals, and base-yield changes in a
contributing recipe also flag the saved list. Recipe edits update this notice across
open tabs and synchronized devices; recipe names and other metadata do not flag it.
Older saved lists without captured cooking times show an unavailable source status
until explicitly regenerated; their reviewed items and quantities are kept.
**Regenerate from updated plan** rebuilds the saved period, even if different dates
are drafted in the generation form. Generating again replaces those
requirements, resetting their quantity edits and removals. It asks for confirmation
only when generated items remain. Manual shopping items and their quantities are kept. **Keep current list**
or Escape cancels replacement. The current list survives reloads.
Reviews and manual groceries work offline and share household ownership with planned
cookings when synchronization is enabled. This adds no pantry or leftover inventory.
After review, the shopping-list page offers **Export PDF**, **Open checklist**,
and **Complete shopping** directly. **Export PDF** downloads a printable list;
**Open checklist** opens a separate view for checking groceries off in the app.
The review view keeps quantity editing separate from check-off controls.
The PDF includes the cooking period, reviewed quantities,
separate manual groceries, and captured recipe contributions, with printable
checkboxes and automatic page breaks. Fonts are bundled, so exporting also works offline.

Checklist progress saves locally and synchronizes across household members when a
backend is enabled. Checking every generated and manual item completes shopping.
**Complete shopping** also completes it with unchecked items remaining. Completion
keeps the reviewed quantities, manual groceries, and recipe contributions available;
exporting a PDF leaves completion and check marks unchanged. Generating a new list
starts fresh progress while retaining manual groceries and their quantities.
Supermarket handoffs remain later work.

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
and recipe identity. Standalone mode has one local person without login; enabling
synchronization adopts its ratings into the signed-in account. Existing recipe collections
upgrade in place without discarding recipes.
Planned cookings, cooking sessions, and food-log entries are separate personal records
belonging to that local identity; upgrading storage preserves the identity,
recipes, cover photos, ratings, plans, shopping lists, cooking sessions, and existing food-log entries.

Manual recipe and food-log actions need no AI provider or external food service.

Data belongs to the installed app's data folder (see [docs/desktop.md](docs/desktop.md)). Deleting
that folder removes recipes, photos, ratings, plans, shopping lists, cooking sessions, and the food
log; backups beyond the household server's copy are later work. Older browser data moves with the
explicit [browser transfer](docs/browser-transfer.md).

## Development and verification

```sh
npm run test:prepare      # frontend, desktop app, server, companion
npm run typecheck
npm run check:rust
npm test                  # installed-app (desktop, tablet) and browser journeys
cargo test --workspace    # core, sync engine, server (real SQLite and HTTP)
```

The Playwright suite drives the **packaged desktop app**: it launches the real executable with an
isolated data folder and WebView2 profile, attaches over the DevTools protocol, and exercises real
SQLite through the real native bridge. A restart is a real process restart. Synchronization
journeys run two app processes against a real household server. Browser journeys run a real browser
against a real server that serves the built frontend (server downtime, expired logins, failed
saves, cross-account denial, and concurrent installed/browser editing). Rust integration tests
cover the same behavior without a UI: workflows and rollback against real SQLite, versioned
migrations from an unversioned server database, the browser-profile import, and two embedded cores
synchronizing with a real server over HTTP. No external provider credentials are needed; companion
workflows use the real native process with a deterministic local OAuth/JWKS provider fixture, and
live ChatGPT sign-in and generation are manual checks.
To run one workflow:

```sh
npx playwright test tests/recipes.spec.ts --project=desktop --grep "create a recipe"
```

`npm run typecheck` checks application, build configuration, and browser tests. Run
`npm run wasm:build` first after cloning or modifying the Rust export interface.
Rust changes need a new WebAssembly build; restart `npm run dev` or build it again.

## Layout

- `src/`: React screens, the typed boundary to the core (`core.ts`), and presentation-only previews.
- `crates/core/`: the application core: workflows, validation, SQLite and migrations, synchronization, browser-transfer import.
- `crates/recipe-domain/`: Rust domain rules (recipes, scaling, shopping, merge), also compiled to WebAssembly for previews.
- `crates/desktop/`: the Tauri desktop host; `crates/secure-store/`: Android Keystore plugin.
- `crates/backend/`: the household server's HTTP adapter over the core.
- `crates/ai-companion/`: optional native ChatGPT authorization and execution, until the integrated flow lands.
- `tests/`: installed-app and browser journeys; `docs/`: guides, ADRs; `GLOSSARY.md`: domain vocabulary.

The application implements standalone recipes ([issue #2](https://github.com/n-sim/forkcast/issues/2))
and recipe cover photos and personal ratings ([issue #3](https://github.com/n-sim/forkcast/issues/3)),
plus personal weekly planning and today's cooking ([issue #5](https://github.com/n-sim/forkcast/issues/5)), ingredient scaling, allocations, and compatible conversions
([issue #4](https://github.com/n-sim/forkcast/issues/4)) and resumable guided cooking
with foreground timers ([issue #9](https://github.com/n-sim/forkcast/issues/9)) and optional
backend household accounts ([issue #22](https://github.com/n-sim/forkcast/issues/22)).
Recipe nutrition and retained portion logs are implemented in
[issue #13](https://github.com/n-sim/forkcast/issues/13).
Household recipes, photos, nutrition, and personal ratings synchronize through
the optional backend ([issue #23](https://github.com/n-sim/forkcast/issues/23)).
Shopping generation, recipe contributions, review, and separate manual groceries are
implemented in [issue #6](https://github.com/n-sim/forkcast/issues/6).
Source-period change notices and explicit regeneration with manual groceries preserved
are implemented in [issue #7](https://github.com/n-sim/forkcast/issues/7).
The separate shopping checklist, shared progress, completion, and PDF downloads are
implemented in [issue #8](https://github.com/n-sim/forkcast/issues/8).
Standalone ChatGPT connection setup is implemented in [issue #16](https://github.com/n-sim/forkcast/issues/16).
Editable AI recipe generation with personal prompt defaults is implemented in [issue #17](https://github.com/n-sim/forkcast/issues/17).
Cooking history, other AI workflows, personal plan/log synchronization, explicit conflict resolution,
and backups are later work.
