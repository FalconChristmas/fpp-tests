# Coverage ledger

One row per fpp commit, saying whether the suite covers it and how that was
established. A commit is listed whether or not it got a test, so a row is the
record that it was examined.

`fpp-since-5.0.tsv` covers every non-merge fpp commit on master since 5.0
(tab-separated, newest first). It replaces `fpp-since-5.0.tsv`, which had
replaced `fpp-since-8.5.1.tsv` and `fpp-10.0-10.2.tsv`; every row of those is
carried over, with the work done on them. The 5.0..7.0 commits were added as
`todo` rows and then triaged: the ones master has replaced are `superseded`,
and changes with nothing to assert (hardware-only, packaging, cosmetic) are
`untestable`, with the reason in the note.

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
| feature | the feature it belongs to, for picking work by subject (`LED panels`, `Network, Apache & security`, …): from the commit's scope, or the files it changes when it has none. A heuristic, so correct a row by hand; the script fills only blank cells |
| where   | where a test for it would run, for each kind of file it changes: `docker` (scenarios), `web` (Playwright), `device:bb`, `device:pi`, `device:mac` or `device` (any device with the hardware), `os-image` (image build, OS packaging, systemd), `build`, or `none` |

## Keeping it current

    python3 scripts/ledger-update.py ledger/fpp-since-5.0.tsv

adds a row for each new fpp commit (from `../fpp`'s `origin/master`; fetch it
first) and refreshes the rows it filled in itself, whose note starts with
`auto:`. A row whose note doesn't start with `auto:` is never touched, so edit
rows in place and change the note; never regenerate the file over them.

## Taking a share

Pick rows by `release`, `feature` or `where`, e.g. every Docker row of 10.0 still
to do, or the open rows of each feature, most first:

    awk -F'\t' '$2=="todo" && $7=="10.0" && $10 ~ /docker/' ledger/fpp-since-5.0.tsv
    awk -F'\t' '$2=="todo" || $2=="named" {print $9}' ledger/fpp-since-5.0.tsv | sort | uniq -c | sort -rn

For each: write a test that fails without the commit and passes with it
(`scripts/verify-fix.sh`), name the commit in the test, and set the row's
outcome, test, proof and note. A `named` row needs only the check: run the
test on the commit's parent, and if it fails there, record the proof. A commit
that can't be tested gets `untestable` and the reason, e.g. a Debian 13
packaging change that only an image build exercises.

## Clearing what master has replaced

    python3 scripts/ledger-supersede.py --rows-from OTHER.tsv ledger/fpp-since-5.0.tsv

looks at each `todo` row of the ledger that is not in OTHER (a ledger of rows
already examined) and marks it `superseded` when every file it changed is gone from master, none of
the (five or more) lines it added is still there, or ten percent or fewer of
at least eight are. A row left `todo` gets a note saying how many of its added
lines master still has, so the rest can be read starting with the ones that
survive. The notes start with "script check:": a person who reads a row and
disagrees should change the outcome and rewrite the note.
