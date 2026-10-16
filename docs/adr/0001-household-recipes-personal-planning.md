---
status: accepted
---

# Share recipes by household and keep planning personal

Meal-plan and shopping-list ownership in this record is superseded by [ADR 0014](0014-share-household-planning-and-shopping.md). The remaining decisions continue to apply.

Forkcast primarily serves an individual coordinating food for their household. Recipe collections belong to a household, while meal plans, shopping lists, food logs, and nutrition goals belong to an individual; a personal meal plan can still provide food for multiple household members. This supports the user's household workflow without making planning or nutrition tracking collaborative by default.

Cooking counts and last-cooked information belong to the household recipe entry. Recipe difficulty, active time, and total time are shared, while recipe ratings are personal. Explicitly marking a recipe cooked and completing guided cooking are both entry points for recording a single cooking occurrence.

The first backend user administers the instance and creates or invites household accounts. Credentials are managed locally without requiring email or an external identity provider; standalone mode requires no login.
