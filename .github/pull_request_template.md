## Merge danger

- **Door:** two-way / one-way
  <!-- one-way: changes the saved-graph format, the share/URL format, or
       anything that cannot be undone by reverting this PR. Merging to main
       always deploys to the public Pages site; that alone is still two-way. -->
- **Blast radius:** one block / parser or SQL generation / whole page

## What changed

<!-- A few lines of pseudo code or before → after. Not prose. -->

## Verified

- [ ] `node tests/run.mjs`
- [ ] `node tests/roundtrip-fuzz/run.mjs`
- [ ] `/standards-review` run
