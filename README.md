# Forkcast

A local-first recipe collection with household cooking plans and shopping, resumable guided cooking, and a personal food
log. Create recipes, plan cooking, and record intake without an account, application backend, or
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

Connecting an account alone leaves standalone records on this device. After signing
in, choose **Enable recipe synchronization** in Settings to share existing and future
recipes, cover photos, ingredients, step allocations, base yield, difficulty, labels,
times, and current/retained nutrition versions with the household. The first enable
also adopts this device's standalone ratings into the signed-in account. Ratings
remain personal: switching accounts displays that account's ratings, and another
device signed into the same account receives them. Removing a photo or rating also
synchronizes. The household meal plan and single active shopping list also synchronize,
with equal editing rights for administrators and members. Food logs and cooking sessions
retain their existing device-local personal identity.

Devices with existing meal plans or shopping lists receive **Review device planning
data** before adopting shared planning, including devices already synchronizing
recipes. Select planned cookings to add; possible duplicates in the household plan are
highlighted. Keep the household shopping list or replace it with the device's list.
**Continue with household data** discards the device's local plan and shopping list.
**Cancel** leaves both sides untouched and keeps the review available to reopen.
Devices without existing planning data adopt the shared household data directly.

Planned cookings can be added, edited, or removed by any member. Shopping quantities,
manual items, and removals are shared. Independent or identical changes
combine automatically, including edits to different fields of the same entry. Competing
changes to one field, or deletion versus editing, retain alternatives for explicit
resolution through **Review planning conflicts**. Unsaved quantity drafts and open
planning forms retain their starting version while incoming changes appear.
Regeneration replaces generated shopping requirements; competing edits to those
requirements require resolution, while independent manual groceries combine and
survive. There is one active shopping list and no shopping-list history.

Local reads and saves continue during backend outages and offline reopening. Recipe,
photo, rating, meal-plan, and shopping-list changes are saved durably before
synchronization and survive reloads.
Synchronization retries every five seconds, on focus, and when connectivity returns;
**Sync now** in Settings retries immediately. Settings shows pending work, connection
errors, and completion. Signing out pauses synchronization and hides account ratings;
pending personal changes retain their original account owner until that account signs
in again. **Disconnect backend** forgets the connection and keeps local work. When a
backend is unavailable, an existing server session expires normally; use **Sign out**
while connected to revoke it immediately.

Each browser profile links its collection to one backend household. Another backend
or a replacement household needs a separate browser profile, preventing pending work
from being uploaded to an unrelated collection. Reconnecting to the original household
resumes synchronization without importing standalone ratings again.

Competing recipe edits retain both revisions and display an unresolved-edit notice.
Only a direct successor advances the current shared recipe; another branch never
silently replaces it. Choose **Review recipe conflicts** in the notice to inspect
competing contents, photos, and nutrition, then **Make current** on the alternative
your household wants to use. Choosing requires a connection to the backend. If the
alternatives change during review, review the latest edits and choose again. The
choice synchronizes across connected devices. Resolved alternatives leave the review
view; ordinary recipe views always show current contents, without a history browser.
Retained nutrition identities are immutable, so old food-log entries keep their
original quantities and nutrition through synchronization and conflict resolution.

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
without granting access to another person's records. Synchronization
endpoints apply these same owner checks. Client-supplied roles or household
identities are not accepted when creating accounts.

The recipe synchronization API exposes household-scoped
`GET /api/households/{id}/recipes` and
`POST /api/households/{id}/recipe-revisions`. Revisions carry stable identities,
their parent, validated recipe contents, the shared cover photo, and retained nutrition
versions. Retrying an accepted revision is idempotent; reusing an identity with different
contents is rejected. The current-recipe pointers and retained revisions are read from
one SQLite snapshot. Account-scoped `GET/POST /api/accounts/{id}/recipe-ratings`
never returns another person's ratings, including to an administrator. Rating removals
and retried mutations retain identities so replay cannot resurrect an older rating.
Recipe validation and nutrition calculations use the same Rust domain crate as the
browser. SQLite transactions retain shared revisions, nutrition, and personal ratings
across backend restarts. API responses and photo contents are never added to the
service-worker cache; synchronized data is read from IndexedDB when offline.

Household planning uses authenticated `GET/POST /api/households/{id}/planning`
and `POST /api/households/{id}/planning/resolve`. Changes carry immutable mutation
identities, a known base revision or preceding mutation, and the contents seen
when the edit began. These expected contents keep an unrelated queued edit from
republishing fields previously merged into the device's view. Retries are idempotent;
field merging and validation use the shared Rust domain crate in the browser and
backend. Resolution checks the reviewed alternatives and rejects stale choices.
SQLite retains the synchronization bases and unresolved alternatives needed to
reconcile offline work; these do not expose a shopping-list history.

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
household members. They save to IndexedDB, survive reopening offline, and remain
independent of backend account connections until record synchronization is added.
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
**Regenerate from updated plan** rebuilds the saved period, even if different dates
are drafted in the generation form. Generating again replaces those
requirements, resetting their quantity edits and removals. It asks for confirmation
only when generated items remain. Manual shopping items and their quantities are kept. **Keep current list**
or Escape cancels replacement. The current list survives reloads.
Reviews and manual groceries work offline and share household ownership with planned
cookings when synchronization is enabled. This adds no pantry or leftover inventory.
The generation and review view edits the requirements and manual groceries. After
review, a separate view will offer PDF export or an in-app checklist in
[issue #8](https://github.com/n-sim/forkcast/issues/8). Supermarket handoffs are also
later work.

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

The production build caches the application and WebAssembly assets using a service
worker. After the first online visit and cache installation, it can reopen offline.
The development server does not install an offline cache. Manual recipe and
food-log actions need no AI provider or external food service.

Browser data belongs to the browser profile and origin. Clearing site data removes
recipes, photos, ratings, plans, shopping lists, cooking sessions, and the food log; private browsing may discard them when the session ends. Cross-device
synchronization requires the optional backend; backups are subsequent work.

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
standalone records while disconnected or offline. Synchronization workflows cover
shared photos and metadata, private ratings across devices and account switches,
retained food-log nutrition, backend outages, durable pending changes, removals,
and competing edits retained through backend restarts. Focused HTTP tests cover ownership,
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
- `crates/recipe-domain/`: Rust recipe types, normalization, validation, scaling, conversions, shopping aggregation, and step timers, also
  usable by native Rust code. Generated WebAssembly is not committed.
- `crates/backend/`: optional Rust HTTP service, SQLite accounts, recipe synchronization, authentication, and ownership boundaries.
- `tests/`: browser workflow specifications, the confirmed main testing seam.
- `docs/adr/` and `GLOSSARY.md`: accepted decisions and domain vocabulary.

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
Cooking history, AI, personal plan/log synchronization, explicit conflict resolution,
and backups are later work.
