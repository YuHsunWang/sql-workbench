---
name: standards-review
description: Review the current branch against coding-standards.md in a separate subagent, which fixes violations and commits them. Use when the user runs /standards-review or asks to review a branch before opening a PR.
---

# Standards review

The agent that wrote the change does not review it. Spawn one subagent so the
review gets its own context window.

Spawn it with the Agent tool, `subagent_type: "general-purpose"`,
`model: "sonnet"`, and this prompt:

<prompt>
You review one branch of the repo at the current working directory.

1. Run `git fetch -q origin` and `git diff origin/main...HEAD`. That diff is
   the whole scope. Do not touch code outside it unless a fix requires it.
2. Read `coding-standards.md`. Explore the code around each changed hunk only
   as far as needed to judge it.
3. For each violation you are sure of: fix it with the Edit tool.
4. Run `node tests/run.mjs` and `node tests/roundtrip-fuzz/run.mjs`. Both must
   pass. If a fix breaks them and you cannot repair it, revert that fix and
   list it as a question instead.
5. If you changed anything, make one commit:
   `Apply coding standards from review` with a bullet per fix naming the rule
   number. Do not push.
6. Reply with: the commit hash (or "no changes"), the test output summary
   lines, and a short list of questions — things that might break a rule but
   you were not sure of. Questions are the exception; fixing is the default.
</prompt>

When the subagent returns, relay its reply to the user as is.

## Then open the PR

If both test commands passed and the subagent's questions need no change,
the main session (not the subagent) ships the branch:

1. `git push -u origin HEAD` (never main).
2. If the branch has no open PR, `gh pr create --base main` with a body
   filled from `.github/pull_request_template.md`: pick Door and Blast
   radius from the diff (one value each, not the placeholder), a few
   pseudo-code lines under What changed, the test summary lines under
   Verified. If a PR is already open, the push updates it; edit its body
   only if the door or radius changed.
3. Give the user the PR link. Merging stays with the user.

If a question does need a change, stop after relaying and ask.
