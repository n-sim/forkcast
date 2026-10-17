---
status: accepted
---

# Create a nutrition version for every nutritional change

Every change to a recipe's calories, protein, fat, or carbohydrates creates a new nutrition version. Recipe-linked food-log entries retain their nutrition-version reference and portion count, preserving their previous values rather than automatically adopting nutritional corrections. Manual entries hold their own nutritional information.

Nutrition versions preserve the per-portion basis. Changing the recipe's base yield while retaining its total nutritional values changes the per-portion values and creates a nutrition version; scaling a planned cooking does not. An explicit "Use current nutrition" action can update an individual food-log entry's reference, leaving other entries unchanged.

Ingredient edits alone retain existing nutrition and suggest AI reestimation when AI is configured; adopting different estimated values creates a new nutrition version. Versioning serves the interaction with the food log, rather than providing general browsing of past recipe contents.

Food-log entries referring to older nutrition versions indicate that fact. For an active recipe, navigating from one opens the current recipe with a notice about the older nutrition version used by the entry. Archiving a recipe retains past food-log entries and their nutrition, but removes navigation from those entries to the recipe. Ongoing cooking sessions and synchronization conflict resolution separately preserve recipe contents for their own purposes.
