# Coverage ledger

One row per fpp commit, saying whether the suite covers it and how that was
established. A commit is listed whether or not it got a test, so a row is the
record that it was examined.

`fpp-since-9.5.tsv` covers every non-merge fpp commit after 9.5, up to master
(tab-separated, newest first). It replaces `fpp-10.0-10.2.tsv`, whose rows it
carries unchanged.

| column  | meaning |
|---------|---------|
| commit  | fpp commit (short hash) |
| outcome | `new-test`, `covered-marked` (an existing test already covered it; its hash was added to that test's docstring), `coverage-only` (exercised, but no red-before check), `superseded` (a later commit replaced or removed the change), `untestable` (with the reason in `note`); and, filled in by the script, `named` (a test names the commit, not yet checked) and `todo` (not examined yet) |
| test    | the test(s), as `file::test name` |
| proof   | `red-green-revert` (fails with the fix reverted on master, passes on master), `red-green-parent` (fails on the fix's parent), `red-green-device` (the same, on a device), `control-run`, `unreviewed` (a `named` row), or `none` |
| note    | what the red failure was, or why there is no test |
| subject | the fpp commit's subject |
| release | the first release the commit shipped in, counting a cherry-pick onto a release branch; `unreleased` if none yet |
| area    | the commit's scope, or the directory it changes |
| where   | where a test for it would run, for each kind of file it changes: `docker` (scenarios), `web` (Playwright), `device:bb`, `device:pi`, `device:mac` or `device` (any device with the hardware), `os-image` (image build, OS packaging, systemd), `build`, or `none` |

## Keeping it current

    python3 scripts/ledger-update.py ledger/fpp-since-9.5.tsv

adds a row for each new fpp commit (from `../fpp`'s `origin/master`; fetch it
first) and refreshes the rows it filled in itself, whose note starts with
`auto:`. A row whose note doesn't start with `auto:` is never touched, so edit
rows in place and change the note; never regenerate the file over them.

## Taking a share

Pick rows by `release`, `area` or `where`, e.g. every web row of 10.0 still
to do:

    awk -F'\t' '$2=="todo" && $7=="10.0" && $9 ~ /web/' ledger/fpp-since-9.5.tsv

For each: write a test that fails without the commit and passes with it
(`scripts/verify-fix.sh`), name the commit in the test, and set the row's
outcome, test, proof and note. A `named` row needs only the check: run the
test on the commit's parent, and if it fails there, record the proof. A commit
that can't be tested gets `untestable` and the reason, e.g. a Debian 13
packaging change that only an image build exercises.
