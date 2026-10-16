---
status: accepted
---

# Share meal plans and shopping lists by household

Meal plans and shopping lists belong to the household, replacing the personal ownership chosen in [ADR 0001](0001-household-recipes-personal-planning.md). All household members have equal rights to add, change, and remove planned cooking and to edit, regenerate, and check off shopping items; account administration remains separate. Each household has one active shopping list, giving members one shared source of shopping requirements instead of parallel personal lists, with no shopping-list history. Food logs and nutrition goals remain personal.

The optional backend synchronizes the household's meal plan and active shopping list alongside its recipes. Standalone use and offline edits remain supported under [ADR 0002](0002-optional-self-hosted-backend.md); using the same household data across devices requires the backend.

Synchronization combines independent and identical changes automatically, including changes to different fields of the same planned cooking or shopping item. Competing changes to the same field, or deletion versus editing, are retained for explicit resolution, following the recipe-conflict policy in [ADR 0008](0008-preserve-conflicting-recipe-edits.md). These rules also apply when offline changes reconnect. Retained conflict alternatives do not create additional active shopping lists.

Shopping-list regeneration replaces the recipe-generated requirements, retaining the review behavior in [ADR 0005](0005-review-shopping-without-pantry-inventory.md). Concurrent edits to those generated requirements require explicit resolution against the regeneration. Independent changes to manual shopping items combine and survive regeneration.

When a device first adopts shared planning with an existing local meal plan or shopping list, an explicit import review must appear before switching to shared planning. This includes devices already synchronizing recipes. The review lets the person select planned cookings to add, highlights possible duplicates for review, and offers a choice between keeping the household shopping list and replacing it with the device's shopping list. Import uses the same conflict rules if household data changes concurrently.

The review also offers **Continue with household data**, which discards the device's local meal plan and shopping list and continues with the household's data. Cancelling the review leaves both the device's data and the household's data untouched. These choices reconcile existing device data deliberately instead of publishing it automatically.
