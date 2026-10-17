---
name: retro
description: Look back over recent work on this repo and propose automated checks, coding-standards changes, navigation pointers and trims, so the next review has less to catch. Use when the user runs /retro, optionally with a start date (default: 7 days ago).
---

# Retro

Goal: never write the same review comment twice. Every defect a review caught
should make the next one less likely, preferably by a check that runs on its
own.

## 1. Gather (since the given date, default 7 days ago)

- `git fetch -q origin` then `git log origin/main --since=<date> --format='%h %s%n%b'`
  and the same for any local branches not yet merged.
- Commits titled `Apply coding standards from review`: each bullet is a
  defect the writing agent made and the reviewer fixed. These are the main
  input.
- Commits whose subject starts with Fix / Stop / Refuse / Keep: defects that
  reached main.
- `gh pr list --state merged --search "merged:>=<date>" --json number,title,comments,reviews`
  and the comments in them.
- This conversation, if it contains the work being looked back on.

Read diffs only for the commits you are going to cite.

## 2. Propose

Group findings into the four kinds below. Each proposal names its evidence
(commit hash or PR number) and gives the exact text or test to add.

1. **Automated check** — a test in `tests/run.mjs` (through the loader API,
   per rule 5) or an assertion in `tests/roundtrip-fuzz/run.mjs`. If a defect
   breaks a rule already in `coding-standards.md`, the rule did not hold: the
   proposal is a check, not a reworded rule.
2. **Coding standard** — add a rule for a defect that came up at least twice
   and cannot be checked mechanically; or remove a rule nothing has broken and
   no check needs.
3. **Navigation pointer** — where an agent searched long for something (a
   function, where a step is rendered, which test covers what), a one-line
   comment or section header in `sql-blocks.html` that would have led it there.
4. **Trim** — a rule, skill or comment that is long, duplicated, or no
   longer true.

Nothing found in a kind → say "none" for it. Do not pad.

## 3. Apply what the user picks

Show the proposals as a numbered list and stop. Apply only the numbers the
user picks. Then run `node tests/run.mjs` and `node tests/roundtrip-fuzz/run.mjs`,
and for each new check, break the code it guards once to see it fail, then
restore it. Commit as `Retro <date>: <short summary>`. Do not push.
