# Moving data from the old browser version

Before the installed app, Forkcast stored everything in a web browser's
IndexedDB. A native app cannot read another application's browser storage, and
a browser tab served by the household server no longer keeps its own copy, so
the move is an explicit export and import. It is a migration tool, not a
general backup and restore feature.

## Procedure

1. In the browser profile that holds your data, open
   `…/legacy-export.html` on the **same address you used before** (the
   household server serves it next to the app; a static copy of the old site
   works too). Choose **Create transfer file**. Nothing in the browser is
   changed or deleted; the file is saved by the browser.
2. In the desktop app open **Settings → Move data from your browser** and
   choose the file.
3. The core validates the whole file first. If anything is wrong it reports
   what, imports nothing, and you can fix or re-export and try again.
   Otherwise it applies everything in one transaction.
4. Check your recipes, plans, and food log. Only then delete the browser's
   data, if you want to, with the browser's own site-data controls. Forkcast
   never does this for you.

Importing the same file again does nothing; importing a newer export of the
same browser adds only what is missing. The browser keeps its copy until you
decide otherwise, so an interrupted import simply starts over.

## What is carried over

Recipes with retained revisions, nutrition versions (and the food-log entries
that reference them), cover photos, ratings, the meal plan, the current
shopping list and checklist progress, resumable cooking sessions with their
captured recipe and timers, food-log entries and the selected day, personal AI
prompt defaults, the local person's identity (in a fresh app; an app that
already has data keeps its own identity and maps the records to it), and, for a
browser that had joined a household, the household link, recorded competing
edits, and every pending change with the account that made it.

## What is never carried over

Server session tokens, ChatGPT/companion credentials, and service-worker
caches. A browser that had joined a household arrives **signed out**: sign in
again under Settings → Backend &amp; accounts and the pending changes deliver
under the original account.

Older shopping lists other than the current one are not carried over (the app
only ever showed the current list); the import report says so.

## File format (version 1)

A JSON object:

```text
format                 "forkcast-browser-transfer"
version                1
exportId               unique id of this export (makes repeats harmless)
exportedAt, source     informational
localPersonId          the browser profile's person id
recipes[]              the live recipes (with nutritionVersionId, syncRevisionId)
coverPhotos[]          {recipeId, mime, data(base64)}
nutritionVersions[]    {id, recipeId, perPortion}
recipeRevisions[]      {id, parentId, recipe, nutritionVersions[], coverPhoto, pending}
ratings[], ratingChanges[]
plannedCookings[], shoppingLists[]      (with personId or householdId scope)
cookingSessions[], manualFoodLogEntries[], recipeFoodLogEntries[]
settings               foodLogDates{}, shoppingListIds{}, recipeSyncBinding,
                       recipeSyncCurrent[], planningSync{binding,snapshot,pending[]}
aiPrompts{}            owner → prompt
backend                null, or {url, accountId, householdId}   (never a token)
```

A different `version` is refused with a message to use the matching export
tool. The exporter (`src/legacy-export.ts`) is read-only migration code and is
to be removed once the migration window closes.
