# Coding standards

Read by the review agent (`.claude/skills/standards-review`), not by the
agent writing the change. Each rule comes from a defect this repo actually
shipped; the commits are listed so the reason can be checked.

## 1. Never change what the user's SQL means

Pasted SQL the steps cannot hold is refused with a message saying why. It is
never imported as something close, dropped, or rewritten into another query.
A silent change is worse than a refusal: the user trusts the steps and runs
the wrong SQL.

- Seen in: 1dbd068, 5af49f2, af7a840 (CASE without ELSE became the
  text 'null'; ORDER BY 2 lost its position; CONVERT dropped from a JOIN key).
- Check: every new branch in `parseSQLText` / `astToGraph` either builds an
  equivalent graph or throws `{sqlErr:true, msg, pos}`.

## 2. SQL → steps → SQL keeps its meaning

Any change to parsing (`parseSQLText`, `astToGraph`) or generation
(`buildSQL`, `condSQL`, `lit`, `q`, `tableRef`) adds a round-trip case to
`tests/run.mjs`. A new SQL shape also gets a family in
`tests/roundtrip-fuzz/run.mjs`, which fails (and CI with it) on any round
trip that changes the result.

- Seen in: 90aa0dc, 7f1b181, 2f0509f.

## 3. Escape everything the user typed or pasted

Table names, aliases, column names, literal values and notes are escaped
before they reach `innerHTML`. Quoted names or string aliases carrying HTML
are refused at the tokenizer. A new place that renders a value adds its
SQL to the `positions` list in the "every block, step and panel" test.

- Seen in: 5cebbfd, 1dbd068, af7a840.

## 4. The page does not lie

Sample rows are invented; the UI says so wherever they appear. Nothing claims
a preview is the database's real result. An empty result is not reported as a
missing connection.

- Seen in: 560f2aa, 8f56daf.

## 5. Tests go through the public API

New tests call what `tests/loader.mjs` exports (`loadApp`, `graphFromSQL`,
`installGraph` and the `exported` list). They do not slice
`sql-blocks.html` by string (`indexOf('function …')`, regex over source) to
reach internals: such a test breaks on a rename and passes on a real bug.
If a needed function is not exported, add it to `exported`.

- Exception: lint-style checks over the markup and stylesheet as a file
  (the `css:` and `html:` tests) read the source on purpose; they check the
  file, not the program's internals.
- A test asserts behaviour that matters to the user, so it can fail when the
  logic changes. Restating a constant (`assert.equal(LIMIT, 280)`) is not a
  test.

## 6. Each test says why

A block comment above the test names the defect it guards against, in one or
two sentences, as the existing tests do.
