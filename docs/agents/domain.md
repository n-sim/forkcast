# Domain docs

This repo uses a single-context layout:

- `GLOSSARY.md` at the repo root: domain vocabulary.
- `docs/adr/`: architecture decision records.

## Before exploring

Read the root glossary and ADRs relevant to the area being explored.

If these files do not exist, proceed silently. Domain modeling creates
them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests.
Respect any synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the project uses it;
otherwise note the gap for domain modeling.

## Surface ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain
why the decision should be reconsidered.
