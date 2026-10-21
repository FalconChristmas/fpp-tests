# Coverage ledgers

One row per fpp commit in a release range, saying whether the suite covers it
and how that was established. A commit is listed whether or not it got a test,
so a row is the record that it was examined.

`fpp-10.0-10.2.tsv` covers every commit from v10.0 to v10.2 (tab-separated):

| column  | meaning |
|---------|---------|
| commit  | fpp commit (short hash) |
| outcome | `new-test`, `covered-marked` (an existing test already covered it; its hash was added to that test's docstring), `coverage-only` (exercised, but no red-before check), `superseded` (a later commit replaced or removed the change), `untestable` (with the reason in `note`), `open-bug` (the fix has no effect on master) |
| test    | the test(s), as `file::test name` |
| proof   | `red-green-revert` (fails with the fix reverted on master, passes on master), `red-green-parent` (fails on the fix's parent), `control-run`, or `none` |
| note    | what the red failure was, or why there is no test |
| subject | the fpp commit's subject |
