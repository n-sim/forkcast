# Application core interface

The `forkcast-core` crate (`crates/core`) is the one implementation of Forkcast's
workflows, validation, transaction ordering, SQLite records, migrations, and pending
synchronization state ([ADR 0015](adr/0015-embed-a-shared-rust-core-and-synchronize.md)).
Installed apps link it directly; the household server hosts it behind the HTTP adapter in
`crates/backend`. The core depends on neither Axum nor an async runtime and opens no port.

## Hosting

A host provides:

- `Config { database, clock }`: the SQLite path and, optionally, a millisecond clock.
- A `Principal`, obtained from the core and passed to every operation.
- Everything platform-specific: where the database lives, credential protection, browser
  launch, file delivery, lifecycle. The core never touches these.

```rust
let core = Core::open(Config::new(path))?;   // migrates; Unsupported if it cannot
let me = core.standalone()?;                 // installed app: persistent local person
let auth = core.authenticate(bearer_token)?; // server: auth.principal
```

`Core` is `Clone + Send + Sync`. Each operation opens its own connection and runs in one
serialized transaction; no SQL handle, transaction, or connection is exposed.

## Principals and ownership

A `Principal` names a person and that person's household, plus a standing: `Local`
(standalone, no login), `Administrator`, or `Member`. Hosts cannot construct one; they get
it from `standalone()` or `authenticate()`. Every operation derives the household and
personal owner from the principal, never from request content.

| Kind | Records | Owner |
| --- | --- | --- |
| Household | recipes and revisions, cover photos, nutrition versions, meal plan, shopping list | the principal's household |
| Personal | ratings, cooking sessions, food log, nutrition goals, AI preferences | the principal's person |

Administrators manage accounts only; they get no access to others' personal records.
Server entry points that name an owner in the request path call
`principal.require_household(id)` / `require_person(id)` before the operation, so the
check holds whatever the UI sends. Records referenced by id (recipes, cooking sessions,
food-log entries, mutation identities) are checked against their stored owner.

`standalone()` creates one local person and household on first use and returns the same
ones afterwards, with no password and no network call. A database that already belongs to
a server is refused with `conflict`, and `join_server` is for `Local` principals only.

## Operations

Operations are methods on `Core`. The native bridge sends them as JSON `Operation` values
(`{"operation": "<name>", ...camelCase fields}`) to `Core::execute`, which returns JSON;
the HTTP adapter exposes the same values at `POST /api/operations`. Both call the same
methods.

| Operation | Fields | Result |
| --- | --- | --- |
| `recipes` | | current recipes: `{recipe, coverPhoto, revisionId, unresolved}` |
| `recipeCollection` | | every revision plus each recipe's head, for review and sync |
| `saveRecipe` | `recipe`, `baseRevisionId?` | `{savedRevisionId, current}`; mints a nutrition version only when nutrition or base portions change; a stale base keeps the edit as a competing alternative |
| `setRecipeCoverPhoto` | `recipeId`, `coverPhoto?`, `baseRevisionId?` | as `saveRecipe`; photos are PNG/JPEG/WebP up to 10 MiB |
| `chooseCurrentRecipe` | `recipeId`, `revisionId`, `expectedRevisionIds` | none; fails with `conflict` if the alternatives changed |
| `archiveRecipe` | `recipeId`, `baseRevisionId?`, `today` (the person's local date) | `{archivedRevisionId, removedCookings}`; see [Archived recipes](#archived-recipes). Repeating it changes nothing (`archivedRevisionId` is `null`) |
| `ratings` / `rateRecipe` | `recipeId`, `value?` (1–5, omit to clear) | ratings / none |
| `mealPlan` / `planCooking` / `removePlannedCooking` | `cooking` / `id` | plan, ordered by day, time, id, with `archivedRecipes` (`{recipeId: name}`) for earlier cookings of archived recipes |
| `scheduleCookings` | `dates` (1–31), `portions`, `minimumRating?` (1–5), `strategy` (`lastCookedLongestAgo`/`leastOftenCooked`) | a proposal `{dates, cookings, replaced, editBase}`: one current recipe per date, meeting the person's minimum rating; changes nothing |
| `generateCookingPlan` | `model`, `request`, `startDate`, `endDate` (up to 31 days) | a proposal as above. Sends the collection, the person's ratings and plan prompt, household cooking history and nearby planned cookings through `aiExecute`; a reply naming anything outside the collection or period, or planning nothing, fails as a whole with `invalid` |
| `applyCookingPlan` | `dates`, `cookings`, `replacing` (ids), `editBase?` | the applied cookings. Replaces every planned cooking on `dates` in one change; other dates are untouched. `conflict` (nothing changed) when a cooking on those dates is not named in `replacing` |
| `planningSnapshot` / `resolvePlanningConflict` | `conflict`, `value` | `{revision, data, conflicts}` |
| `shoppingList` | | `{list, sourceStatus, archivedRecipeIds, conversionOffers}` (`changed`, `unchanged`, `unknown`) or `null`; `conversionOffers` lists generated items (`itemId`, `name`, `dimension`: `volume`/`count`, `declined`) that need an accepted estimate to combine with the same ingredient measured another way |
| `generateShoppingList` | `startDate`, `endDate`, `replacingListId?` | the new list; manual items carry over unchecked; `conflict` unless `replacingListId` names the current list |
| `saveShoppingItem` | `listId`, `kind` (`generated`/`manual`), `item` | the list |
| `estimateIngredientConversion` | `model`, `name`, `dimension` (`volume`/`count`) | `{name, dimension, grams, note}`: the estimated mass in grams of 100 ml (`volume`) or one piece (`count`) of the ingredient. Runs through `aiExecute` and stores nothing; an invalid or implausible reply fails with `invalid` and the list is unchanged |
| `acceptIngredientConversion` | `listId`, `conversion` (an estimate), `editBase?` | the list. Converts the generated item measured by volume or count to grams and combines it with the ingredient's mass; the item keeps `convertedFrom` (the original amounts) and the list keeps the accepted estimate in `conversions` (`status: accepted`, `source: ai`). Both synchronize. Fails with `invalid` for an implausible weight or an ingredient that no longer needs a conversion. Recipe ingredient totals, step allocations, and contributions are untouched |
| `declineIngredientConversion` | `listId`, `name`, `dimension`, `editBase?` | the list; records a `declined` conversion and leaves the quantities separate |
| `removeShoppingItem` / `checkShoppingItem` / `completeShoppingList` | `listId`, `kind`, `itemId` / `itemId`, `checked` / none | the list |
| `cookingSessions` | | the person's unfinished sessions, plus ended ones whose `conflict` awaits a decision; `recipeArchived` marks one whose recipe was archived since it started |
| `startCooking` | `recipeId`, `portions`, `displayUnits?`, `cancelSessionIds?` | `{session, conflicts}`; captures the recipe now; `session` is `null` and `conflicts` lists unfinished sessions unless `cancelSessionIds` names exactly them |
| `saveCookingProgress` | `sessionId`, `step`, `timers` | the session |
| `endCooking` | `sessionId`, `outcome` (`finished`/`canceled`) | none; finishing needs the last step |
| `resolveCookingSession` | `sessionId`, `keep` (`current`/`alternative`) | the session. Keeps the shown progress or the competing `conflict.progress` from another of the person's devices; keeping a finished alternative records its occurrence once. `conflict` when nothing is left to decide |
| `cookingHistory` | | household cooking count and `lastCookedAt` (ms) per cooked recipe: `{recipeId, count, lastCookedAt}` |
| `markCooked` | `recipeId`, `id?`, `sessionId?` | the recipe's history. Records one occurrence for the household; an identical `id`, or a `sessionId` that already has one, counts nothing more. Finishing a guided session records its occurrence once (retrying `endCooking` is accepted); canceling records none. Creates no food-log entry |
| `foodLog` | `date` | `{entries, totals, incomplete, goals}` computed from retained nutrition versions; `recipeArchived` marks entries whose recipe was archived. `goals` is the set in effect on `date` (or `null`), and each total carries its `target` from it |
| `logRecipeFood` | `id?`, `recipeId`, `nutritionVersionId`, `consumedAt`, `portions` | none; an identical retry of the same `id` is accepted |
| `useCurrentFoodNutrition` | `entryId` | `{changed}`; points one of the person's recipe entries at its recipe's current nutrition version, leaving every other entry's reference unchanged. `changed` is `false` when it already used it; `notFound` once the recipe is archived |
| `logManualFood` | `id?`, `description`, `consumedAt`, `nutrition` | none |
| `editFoodLogEntry` | `entryId`, `consumedAt?`, `portions?` (recipe entries), `description?`, `nutrition?` (manual entries) | none; omitted fields keep their value, and a recipe entry keeps its nutrition-version reference. `invalid` for fields the entry's kind does not have |
| `removeFoodLogEntry` | `entryId` | none; `notFound` when the person has no such entry |
| `foodLogConflicts` | none | the person's records changed on two devices: `[{id, kind, key, current, alternative}]`, where `kind` is `manualEntry`, `recipeEntry`, or `goals`, `key` the entry id or effective date, and `current`/`alternative` the stored record (`null` when removed) |
| `resolveFoodLogConflict` | `conflictId`, `keep` (`current`/`alternative`) | none. Keeps the record as shown or the other device's change, including its removal. `conflict` when nothing is left to decide |
| `estimateFood` | `model`, `description?` (up to 2000 characters), `image?` (`{mime, data}`: base64 JPEG, PNG or WebP up to 8 MB) | `{description, nutrition}` for a manual entry; needs a description, an image, or both. Runs through `aiExecute` and stores nothing: the estimate is logged only by a later `logManualFood`, and the image is never retained by any runtime (database, synchronization, migration data, or logs), unlike a recipe cover photo. An invalid reply fails with `invalid` |
| `foodLogDate` / `setFoodLogDate` | `date` | the remembered day |
| `nutritionGoals` | none | the person's goal sets `{effectiveFrom, targets}`, newest first |
| `setNutritionGoals` | `effectiveFrom`, `targets` (`calories`, `protein`, `fat`, `carbohydrates`; `null` sets no goal, others must be above zero, at least one set) | none. Applies from `effectiveFrom` until the next set; the same date replaces that set only, so earlier days keep their goals |
| `removeNutritionGoals` | `effectiveFrom` | none; the previous set applies again |
| `aiPreferences` / `setRecipePrompt` / `setPlanPrompt` / `setCartPrompt` / `setRecipeModel` | `prompt` (up to 8000 characters) / `model?` | `{recipePrompt, recipeModel, planPrompt, cartPrompt}`; never credentials or tokens. `cartPrompt` is the product selection prompt for Gurkerl cart handoffs. Synchronized to the account like ratings |
| `aiStatus` | | `{state, target, email, message, serverUrl, account, canAuthorize, canRetry}` for the principal's execution target (`device` or `server`) |
| `aiAuthorize` | `serverUrl?`, `accountId?` | `{authorizationUrl}`; starts the loopback listener first. A joined app must name its server and account. Refused on a server host |
| `aiCancelAuthorization` / `aiSignOut` | | `aiStatus` |
| `aiRetryTransfer` / `aiCancelTransfer` | | `aiStatus`; resumes or cancels an unfinished handoff to the server |
| `aiModels` | | `[{slug, displayName}]` |
| `aiExecute` | `model`, `instructions`, `input`, `image?` | `{text}`; the one execution interface every AI workflow uses. `image` (as for `estimateFood`) is sent to the provider with this request only |
| `supermarketStatus` | | `{state, message, canConnect}`: the person's Gurkerl connection on this device (`unconfigured`, `authorizing`, `connected`, `denied`, `expired`, `reconnect_required`). `canConnect` is false on a server host |
| `supermarketAuthorize` | | `{authorizationUrl}`; starts the loopback listener first. Refused (`forbidden`) on a server host |
| `supermarketCancelAuthorization` / `supermarketSignOut` | | `supermarketStatus` |
| `fillSupermarketCart` | `listId`, `model` | `{listId, complete, message, items: [{itemId, name, quantity, unit, status, product, note}]}`, `status` being `added`, `failed`, `not_added`, or `skipped` (already checked off). Fills the person's Gurkerl cart from the reviewed list; never changes the list, checks out, or orders. Fails as a whole when nothing was added; once Gurkerl confirmed an addition, an early stop returns `complete: false` with `message`. A replaced list fails with `conflict`; a server host refuses it (`forbidden`) |
| `connectServer` | `serverUrl`, `certificate?` | `{serverUrl, setupRequired, untrustedCertificate}`. `https://` (or `http://` on loopback) only. A server whose certificate is not publicly trusted returns its SHA-256 fingerprint as `untrustedCertificate` and stores nothing; once the person confirms it, connecting again with it as `certificate` pins that certificate for the server (`pendingJoin.certificate`, then `syncStatus.serverCertificate`) |
| `checkServerCertificate` / `trustServerCertificate` | / `certificate` | `{confirmed, presented, trusted}` for a joined profile's server, sending nothing to it / `syncStatus` after pinning a replaced certificate, refused unless the server presents exactly `certificate` |
| `syncState` / `joinServer` / `acknowledgeSync` | `serverUrl`, `remoteHouseholdId`, `remoteAccountId` / `ids` | `{binding, pending}` |

Server-only entry points are Rust methods and HTTP endpoints, not bridge operations:
`server_status`, `setup_server`, `sign_in`, `authenticate`, `sign_out`, `session`,
`accounts`, `create_account`, `change_account`, `ingest_recipe_revision`,
`apply_rating_changes`, `submit_planning`, `cooking_session_snapshot`,
`apply_cooking_session_changes`, `cooking_occurrences`, and `apply_cooking_occurrences`. They keep the existing `/api/...` routes,
bodies, and messages.

### Archived recipes

Archiving appends a revision of the unchanged recipe carrying `archivedOn` (the archiving
person's local date), so it synchronizes as a `recipeRevision` like any edit, and an edit
made elsewhere from an earlier revision is retained as a competing alternative for
`chooseCurrentRecipe` instead of silently reviving or discarding either. A recipe whose
current revision is archived:

- is absent from `recipes` and from planning, scheduling, plan generation, logging,
  starting cooking, and `markCooked` without a session (`not_found` or `invalid`);
  `recipeCollection` keeps every revision for conflict review. Continuing the archived
  revision with `saveRecipe` or `setRecipeCoverPhoto` is refused with `not_found`.
- loses its planned cookings dated on or after `archivedOn`. Every core applies this rule
  whenever it saves the plan (local edits, merged device edits on the server, conflict
  resolution, a newly current archival), so a cooking planned on another device before
  the archival arrived is withdrawn as the plan synchronizes. Earlier cookings stay.
- leaves reviewed shopping lists unchanged; `archivedRecipeIds` names it, a new list draws
  nothing from it, and `sourceStatus` reports the change.
- keeps food-log entries and their retained nutrition (`recipeArchived`), and lets
  unfinished cooking sessions finish from their captured contents (`recipeArchived`),
  recording the household's cooking occurrence.

There is no operation to browse an archived recipe; choosing a competing edit in conflict
review is the only way it returns to the collection.

### Pending synchronization

Once a profile has joined a server, every `saveRecipe`, `setRecipeCoverPhoto`, `rateRecipe`,
planning edit, cooking-session change, cooking occurrence, and food-log or goal change appends to a durable outbox in
the same transaction as the change. Failed operations leave neither. Each entry keeps the
person and household that made it, whatever account later signs in. Kinds: `recipeRevision`
(a revision, as the server's `recipe-revisions` endpoint accepts it), `rating` (a rating
change), `planning` (`{baseData, data}`; the synchronization work adds the server revision it
was based on), `cookingSession`, `cookingOccurrence`, and `foodLog`.

### Cooking sessions and occurrences

Sessions are personal and synchronize only between one account's devices
(`GET`/`POST /api/accounts/{id}/cooking-sessions`, refused for any other account); occurrences
are household records (`GET`/`POST /api/households/{id}/cooking-occurrences`). The core
enforces both: a change to another person's session, or an occurrence naming one, is
`forbidden` whatever path it arrives on.

- A `cookingSession` change is `{id, sessionId, base, progress, session?, resolves?}`, where
  progress is `{currentStep, timers, completedAt, canceledAt}`. The change that starts a session
  carries what it captured (`session`); later changes carry progress only, so resuming on
  another device never recaptures a newer recipe. The server remembers applied change ids, so
  redelivery changes nothing.
- The server merges `progress` with its own against `base`: the step, each step's timer, and
  the outcome combine when only one side changed them. Different changes to the same field,
  or finishing on one side while cooking continued on the other, keep the server's progress
  and retain the incoming one as `conflict: {id, progress}` until `resolveCookingSession`. A
  finished session therefore never resumes without that decision. Sessions started on two
  devices while apart both stay unfinished; the next `startCooking` names them all.
- An occurrence is `{id, recipeId, sessionId?, cookedAt}`. The server records it once by `id`
  and once per `sessionId`, whoever delivers it; devices adopt the server's record of a
  session's cook in place of their own. Occurrences of recipes a device kept to itself when
  joining stay on that device. Nothing creates food-log entries or remaining portions.
- Timers synchronize as persisted timing state (`durationMs`, `remainingMs`, `endsAt`); a
  device derives what is left in the foreground. Nothing runs or alarms in the background.

### Food logs and goals

Food-log entries and dated goal sets are personal and synchronize only between one account's
devices (`GET`/`POST /api/accounts/{id}/food-log`, refused for any other account). The core
enforces the boundary on every path: a change to another person's record is `forbidden`, and the
server checks each record with the shared rules, including that a recipe entry names a recipe of
the household and one of its retained nutrition versions.

- A `foodLog` change is `{id, kind, key, base, value, resolves?}`: the record as the device had
  it and as it is now, `null` when it did not exist or was removed. A recipe entry travels with
  its nutrition-version reference, never with the recipe's latest values. The server remembers
  applied change ids, so redelivery changes nothing.
- The server merges `value` with its own record against `base`, field by field and nutrient by
  nutrient: independent changes (such as new portions on one device and **Use current
  nutrition** on another) combine, and identical ones agree. Competing changes to one field, or
  removing a record that the other side changed, keep the server's record and retain the
  incoming one until `resolveFoodLogConflict`; a newer competing change replaces an older one.
- `GET` returns `{manualEntries, recipeEntries, goals, conflicts}`. Devices adopt it except for
  records with changes still waiting; entries of recipes a device kept to itself when joining
  stay on that device. Planned or completed cooking never creates entries.

Joining with personal records queues the account's food log, goals, and unfinished sessions; joining queues the
recorded cooking of every recipe the device contributes.
`acknowledgeSync` removes confirmed entries and ignores unknown ids. Rejoining the same
household resumes; another household returns `conflict` and needs a separate profile.
Transport, adoption review, and conflict handling for synchronization are separate work.

## Errors

Every failure is an `Error { kind, message, fields? }`. Messages are written for people;
`fields` lists the domain's field-level problems when validation fails.

| `kind` | Meaning | HTTP |
| --- | --- | --- |
| `unauthenticated` | no valid session | 401 |
| `forbidden` | outside the principal's household or person, or not allowed for its standing | 403 |
| `not_found` | the referenced record does not exist | 404 |
| `conflict` | stale or duplicate identity; local changes are kept | 409 |
| `invalid` | validation failed | 422 |
| `rate_limited` | too many sign-in attempts | 429 |
| `connection_required` | the person's ChatGPT connection is missing or ended | 412 |
| `unsupported` | the database is from a newer Forkcast, or an upgrade could not complete; nothing was changed | 500 |
| `internal` | unexpected storage failure | 500 |

`kind` serializes exactly as written above. The HTTP body is
`{"message": "...", "fields"?: [...]}`.

## Change notifications

`core.subscribe(&principal)` returns a `Subscription`. After a transaction commits, the
core publishes `Change { scope, topic }` to each subscriber who may see that scope:
household changes to everyone in the household, personal changes only to that person.
Rolled-back operations publish nothing. A change says what to reload, not what changed.

Topics: `recipes`, `ratings`, `planning` (meal plan and shopping list), `cookingSessions`,
`foodLog`, `preferences`, `sync`, `ai` (connection state, never credentials), `supermarket`
(Gurkerl connection state on this device, never credentials). Scope is `{"kind": "household"|"person", "id": "..."}`.

- Native bridge: deliver each `Change` from `try_next` / `next_timeout` to the frontend.
- HTTP: `GET /api/changes` is a Server-Sent Events stream of `change` events with the same
  JSON, plus a comment every 15 seconds. Authenticate with the bearer header (use
  `fetch`; `EventSource` cannot set it).

## Storage and migrations

Schema versions live in SQLite's `user_version`. Version 1 is the schema the server created
before versions existed, so an existing server database is adopted in place; version 2
adds people (local or account), cooking sessions, food-log entries, person settings, and
synchronization state. Each step runs in one transaction that also records its version,
then checks foreign keys. Existing account ids, session tokens, ratings and rating-change
identities, revisions, nutrition versions, competing edits, planning history, and covers
are copied unchanged. Version 7 adds each person's dated nutrition goals, one set per
effective date. Version 8 adds food-log changes waiting for a decision and the record of
applied food-log changes.

A database newer than the core, or an upgrade that cannot complete, fails `open` with
`unsupported`. The database is left at its previous version with its data intact; there is
no reset path.

## ChatGPT connection and handoff

`crates/core/src/ai` owns sign-in, refresh, revocation, model discovery, and execution for
both hosts, without Axum or any companion process. Connections are keyed by person and held in
`Secrets`, never in SQLite.

- **Standalone** (`aiAuthorize` with no selection): the loopback listener binds first, the host
  opens the returned address, the callback is validated (state, nonce, PKCE, signed identity,
  plan permission) and the session is stored for that person.
- **Joined**: execution always goes to the server (`POST /api/operations` with the same AI
  operations). `aiAuthorize` must carry the active `serverUrl` and `accountId`. The app signs in
  with the server's host identity (`GET /api/ai/host`) and delivers the session with
  `POST /api/ai/transfers/{transferId}`; `DELETE` on the same path cancels. The reply is only
  `{transferId, state}` (`active` or `canceled`). Transfers are idempotent by id; a cancelled id is
  refused afterwards (`409`); cancelling an imported id is refused (`409`) because the server owns
  it. Locally the session is fenced (never used or refreshed) until the acknowledgement arrives,
  then deleted.
- **Server**: imports bind to the authenticated account, require the server's own host identity,
  and refresh serially, persisting each rotated token before use.

Resumption: hosts call `core.resume_ai_handoff()` at launch, focus, and resume.
`connection_required` (412, never 401, so a browser keeps its login) means connect again.

## Gurkerl cart handoff

`crates/core/src/supermarket` fills a person's Gurkerl cart from the reviewed shopping list
through Gurkerl's MCP server (`https://mcp.gurkerl.at/mcp`), without a companion process.

- **Authorization** follows the MCP authorization specification: protected-resource metadata
  (which must name this server), authorization-server metadata (S256 required), dynamic
  registration of a public client for the loopback redirect, and a PKCE authorization-code grant
  with the server as `resource`. The session is keyed by person and held in `Secrets` on the
  installed app that signed in. It is never stored in SQLite, synchronized, transferred to a
  household server, or returned to the frontend; a server host refuses to connect or fill carts.
- **Handoff** reads the shopping list (generated and manual items at their reviewed quantities,
  skipping checked items), lists the MCP server's tools, and lets the person's AI connection
  choose tool calls through `aiExecute`, with the person's `cartPrompt` and the list as input.
  Only tools that read (MCP `readOnlyHint` or a reading verb such as `get`/`search`) or add to
  the cart are offered; checkout, ordering, payment, delivery slots, claims, and removing or
  clearing cart contents are never offered and refused if requested. An item counts as added only
  when Gurkerl confirmed a cart call naming it; what the AI claims does not.
- The shopping list is read, never written: cart population does not check items or complete
  the list.

Release builds always use Gurkerl's server. Debug builds alone accept
`FORKCAST_GURKERL_TEST_SERVER` (an HTTP `127.0.0.1` MCP and authorization fixture) for the
desktop app.
