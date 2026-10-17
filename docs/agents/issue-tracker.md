# Issue tracker: GitHub

Issues and specs live in GitHub Issues. Use the `gh` CLI.
Infer the repository from the Git remote; currently `n-sim/forkcast`.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`
- Read with metadata and comments:
  `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
  with appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <path>`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

For multiline bodies, write the exact text to a temporary file and use
`--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with its labels
and comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. When a reference
is ambiguous, resolve it with `gh pr view <number>` and fall back to
`gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, holding Notes,
  Decisions-so-far, and Fog.
- Child ticket: link it as a GitHub sub-issue. If sub-issues are
  unavailable, add it to the map's task list and place `Part of #<map>`
  at the top of the child body.
- Child labels: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use native GitHub issue dependencies. Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain the blocker's database ID with
  `gh api repos/<owner>/<repo>/issues/<number> --jq .id`.
  If dependencies are unavailable, use a `Blocked by: #<number>` line.
- Frontier: among the map's open children, select the first in map
  order with no open blockers and no assignee.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the ticket, and append a
  concise finding and link to the map's Decisions-so-far.
