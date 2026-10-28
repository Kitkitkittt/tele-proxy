# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Kitkitkittt/tele-proxy`. Use `gh`.

## Operations

- Create: `gh issue create --repo Kitkitkittt/tele-proxy --title "..." --body "..."`
- Read: `gh issue view <number> --repo Kitkitkittt/tele-proxy --json number,title,body,labels,comments`
- List: `gh issue list --repo Kitkitkittt/tele-proxy --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --repo Kitkitkittt/tele-proxy --body "..."`
- Label: `gh issue edit <number> --repo Kitkitkittt/tele-proxy --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --repo Kitkitkittt/tele-proxy --comment "..."`
- Reuse existing issues before creating new ones.

## Pull requests as a triage surface

**PRs as a request surface: no.** Change this to `yes` if external PRs should enter the triage queue.

## Wayfinding

Use one issue as the map and link child issues with GitHub sub-issues when available. Otherwise, include `Part of #<parent>` in each child and list children on the map. Use native issue dependencies where available; otherwise record `Blocked by: #<number>`. Claim work by assignment, record outcomes in the issue, and close it only after its acceptance criteria are met.
