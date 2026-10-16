# Forkcast

Forkcast is a meal planning, recipe management, and nutrition tracking application.

## Language

**Recipe**:
A reusable description of a dish, including its ingredients and cooking instructions.

**Archived recipe**:
A recipe withdrawn from the active collection and future planning, with retained references from past food-log entries, reviewed shopping lists, and already-started cooking sessions.

**Recipe cover photo**:
An image attached to a recipe to represent the dish in the shared collection.

**Recipe label**:
An optional label belonging to a recipe in the household collection, shown wherever that recipe is planned.

**Cooking step**:
One instruction in a recipe's preparation sequence, with any associated ingredient allocations and timers.

**Ingredient allocation**:
The amount of a recipe ingredient assigned to a particular cooking step, drawn from that ingredient's total recipe quantity.

**Nutrition version**:
A retained set of a recipe's per-portion calorie, protein, fat, and carbohydrate values referenced by recipe-linked food-log entries.
_Avoid_: Recipe version

**Household**:
A group of people who share a recipe collection, meal plan, and shopping list and may eat meals prepared together.

**Recipe collection**:
The recipes shared by a household.

**Meal plan**:
A household's shared schedule of recipes to cook, specifying the cooking day and number of portions. It is separate from each person's food log.

**Planned cooking**:
A recipe scheduled to be cooked on a given day in a specified number of portions, optionally with a cooking time.

**Portion**:
A share of a recipe's yield, used to express how much to cook or how much was eaten.

**Cooking session**:
An in-progress guided preparation using the ingredients and instructions captured when cooking started, with step progress and timers.

**Cooking occurrence**:
One recorded instance of cooking a recipe, included in that recipe's household cooking history.

**Recipe rating**:
A person's assessment of a recipe.

**Recipe difficulty**:
A shared household assessment of how difficult a recipe is to prepare.

**Active time**:
The time during preparation that requires a person's dedicated action or attention, preventing them from doing something else.

**Total time**:
The elapsed time from starting the cooking process until the food is ready to consume.

**Shopping list**:
A household's shared list of ingredients and other food to acquire, reviewed against what the household actually needs. Items may come from planned cooking or be added manually.

**Recipe contribution**:
The ingredient requirements a recipe contributed when a shopping list was generated, identifying the recipe as a source of that list's requirements.

**Manual shopping item**:
An item a person adds directly to a shopping list, independently of recipe contributions.

**Food log**:
A person's record of food actually eaten, including when and how much was consumed. It can include recipes and other food, independently of the meal plan.
_Avoid_: Meal plan

**Recipe-linked food-log entry**:
A record of consuming a specified number of portions using a particular nutrition version of a recipe, whose values determine the entry's nutrition.

**Manual food-log entry**:
A record of consumption with its own nutritional information, independent of a recipe. Its nutritional information may be entered directly or estimated from a description or image.
_Also called_: Ad hoc entry

**Nutrition goals**:
A person's daily target amounts for protein, fat, carbohydrates, and calories, applicable during a particular period.

**Nutrition estimate**:
Estimated amounts of protein, fat, carbohydrates, and calories for stated quantities of food.
