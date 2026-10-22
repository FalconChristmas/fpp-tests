# fpp-tests

Regression tests for [FPP](https://github.com/FalconChristmas/fpp)'s runtime, kept out
of the fpp repository so they never land on the devices that check it out.

The suite builds fppd from a given fpp commit, under AddressSanitizer by default, and
runs **scenarios** against it: each one starts a fresh fppd on an empty media
directory, sets up the config it needs, drives fppd through its own HTTP API, and
checks the outcome. A scenario passes only if, at the end:

- every request it made was answered (a request that times out means fppd wedged),
- fppd is still running,
- fppd exits 0 on SIGTERM, and
- the sanitizer reported nothing.

So a scenario catches deadlocks, crashes and memory errors as well as whatever
behavior it asserts on.

## Running

Requires Docker. From this directory, with fpp checked out next to it (`../fpp`):

```sh
./run.sh                                  # every scenario, against ../fpp HEAD, ASan build
./run.sh --ref v10.x                      # any branch, tag or commit in that checkout
./run.sh --flavor tsan                    # asan (default), tsan, debug, optimized or coverage
./run.sh scenarios/test_playlists.py -v   # anything after the options goes to pytest
./run.sh --fpp ~/src/fpp -k presets       # a different fpp checkout
./run.sh -j 6                             # six shards side by side
./run.sh --artifacts /tmp/mine ...        # results somewhere other than artifacts/
```

A scenario spends most of its time waiting on fppd, so one run uses little of the
machine. `-j N` splits the scenarios (or the files and node ids you name) into N shards
balanced by `scripts/shard-weights.json`. Each shard runs in a container and on a
network of its own, and writes its output to `artifacts/shard-N.log`. The shards'
results are merged into `artifacts/junit.xml`. An ASan shard peaks under 1GB of the
Docker VM's memory.

On an FPP device (or any Debian box with a built fpp tree), run against the tree as
it is built right now, uncommitted changes included, without Docker:

```sh
sudo ./run-local.sh                       # tests /opt/fpp/src/fppd; build it first with make
sudo ./run-local.sh --fpp ~/fpp -k presets
```

`--host-audio` instead plays media through the device's own PipeWire and sound card,
and records the card's sink, so a scenario can measure against the card's real clock
(`test_long_song_stays_locked_to_the_sound_card`, opt-in; `FPP_TESTS_LONG_SONG` sets its
length). It is audible on the device.

The device's own fppd keeps running. Each test fppd gets private network, /tmp, /run
and /dev/shm, an overlay over the tree (so its writes to `www/` never reach the real
one), no sound cards or SPI devices, and a read-only /sys. pytest is installed if
missing. ASan doesn't run on FPP's Pi kernels (39-bit address space); use the normal,
debug, tsan or ubsan build there. Check fpp-tests out somewhere other than
`/home/fpp/media`: that directory is overlaid too, and the artifacts would vanish with it.

The `Device` workflow does this nightly on a Raspberry Pi 5, a self-hosted runner in the
org's `Devices` group: it builds fpp master's debug flavor and runs the whole suite with
`--host-audio`, so the scenarios the Docker runs skip (Pi-only fppinit and cape detection,
DPI pixels, framebuffer, KMS, GPIO, serial, the real sound card) run there. It can be
started by hand from the Actions tab for any fpp ref and the debug, optimized or tsan
flavor. A job there is root on the device, so the workflow has no pull_request trigger.

The first build of a commit takes a few minutes; ccache makes later builds of nearby
commits take seconds. Builds are cached per commit and flavor in the `fpp-tests-work`
Docker volume (`docker volume rm fpp-tests-work fpp-tests-ccache` to clear them).

Each run's container is on a Docker bridge network of its own, labelled `fpp-tests`, so
several runs at once (separate fpp-tests copies, or `run-web.sh --serve` left up) can't
find each other's fppd over MultiSync. The run removes its network when it ends; one a
killed run left behind is pruned by a later run once it is an hour old and unused.

Results are a different matter: every run writes to `artifacts/` and empties it first, so
two runs at once from one checkout delete each other's, a failed test's media directory
included. Give each its own with `--artifacts DIR` (run.sh, run-web.sh and verify-fix.sh
all take it); only that directory is emptied, and the paths below are then under it.

`--flavor coverage` builds fppd at -O0 with gcc's `--coverage` and, after the run, writes
`artifacts/coverage/`: `summary.txt` (line and function coverage per source file, least
covered first), `functions.csv` (every function with how often it was called) and `html/`
(per-line detail). It covers fppd's own code under `src/`, not the submodules. Use it to
find what no scenario reaches; it runs no sanitizer, so it is not a substitute for the
ASan and TSan runs.

When a scenario fails, its media directory is copied to `artifacts/<test>/`: `logs/`
holds `fppd.log`, fppd's stdout, any sanitizer report, and, if fppd was still running,
`backtrace.txt` with every thread's stack. For a wedge, read the backtrace first.

Every run also writes `artifacts/junit.xml`, one entry per test.

The suite runs nightly in CI against fpp master: once under ASan, once under TSan, and once in
the coverage build. It can also be started by hand from the Actions tab, for any fpp ref and
flavor. Each run's page in the Actions tab carries a summary: the test counts, any failures,
the slowest scenarios and, for the coverage build, coverage by source directory and the files
with the most unreached lines. The nightly run also publishes the
[dashboard](https://falconchristmas.github.io/fpp-tests/): pass counts and coverage for every
night so far, and the latest coverage report line by line. It is the place to look for
something to test: the directories and files with the most code no scenario reaches.

Under TSan, a data race fails the scenario like any other sanitizer report, except for the
known races listed in `sanitizers/tsan.supp`, each with what it is and how it should be
fixed. A new race turns the nightly run red. When you fix one of the listed races, delete
its lines from that file in the same change. Only fppd's own sanitizer log counts: its
children (scripts, system tools) carry the preloaded runtime but aren't built with it.

## The web UI suite

`web/` holds Playwright tests for the pages under fpp's `www/`. `run-web.sh` builds fpp the
same way `run.sh` does (same options, same cached trees), serves the UI from Docker the way
a player does -- Apache in front of php-fpm, the tree's own site config and a freshly
generated CSP, with the build's fppd behind it -- and runs the suite from this machine
against it:

```sh
./run-web.sh                                   # every test, ../fpp at HEAD, ASan fppd
./run-web.sh --ref v10.x tests/fpp.spec.ts     # anything after the options goes to playwright
./run-web.sh --serve                           # just serve it on 127.0.0.1:8080, until Ctrl-C
```

It needs Docker and Node.js 20+; the first run installs the suite's packages and Chromium.
With `--serve` running, `npx playwright test --ui` in `web/` is the quickest way to write a
test. Any other player works as a target too (`PLAYWRIGHT_BASE_URL=http://<player>`), but the
tests change its settings, so don't point it at one that matters.

A test that has to act from inside the player -- a request from its own loopback, a script
run on it, another host next to it -- uses `web/tests/container.ts`. `run-web.sh` names the
container in `FPP_TESTS_WEB_CONTAINER` (`--serve` prints it, to export for `npx playwright
test`); without it, those tests skip.

A fresh player sends every page to the setup wizard, so the `setup` project finishes the
wizard first, as a user would; if it can't be finished, nothing else runs. The fppd behind
the pages is held to the scenarios' standard: the run fails if it died, wedged, exited non-zero
on SIGTERM or wrote a sanitizer report, whatever the tests themselves said. Results go to
`artifacts/web/`: `junit.xml`, the HTML report (`report/`), failed tests' screenshots and
traces, `fppd.json` with fppd's verdict and, when fppd failed, its media directory and
Apache's logs.

`FPP_TESTS_THEMES=1` runs every test in both color schemes and writes a side-by-side
screenshot report (`web/playwright-report/sightline.html`), for reviewing theme work.

A UI fix gets a test that fails without it, like any other: `scripts/verify-fix.sh` takes a
path under `web/` and runs it through `run-web.sh`:

```sh
scripts/verify-fix.sh 6dd0f6f88 web/tests/page-still-loading.spec.ts
```

The suite runs as the `web` job of the scenarios workflow: nightly against fpp master, with
its counts on the dashboard next to the scenarios', on every pull request here, and by hand
from the Actions tab for any fpp ref (`suites` picks scenarios, web or both).

## Writing a scenario

Scenarios are plain pytest functions in `scenarios/test_*.py` that take the `fppd`
fixture (see `scenarios/fppd.py`):

```python
def test_something(fppd):
    fppd.write("config/commandPresets.json", {...})   # set up the media dir
    fppd.start()                                      # start fppd, wait for its API
    fppd.command("Start Playlist", "Loop", "true", "false")
    fppd.wait_for(lambda: fppd.get("/variables").get("X"), what="X to be set")
```

The fixture provides `write`, `settings`, `start`, `get`/`post`/`command` (which fail
with "fppd is wedged" on a timeout), `wait_for`, and `log`. Helpers for the show itself:

| Module | What |
|---|---|
| `fseq.py` | `write_fseq()` writes sequences with FPP's own `FSEQFile` writer (built from `tools/fseqgen.cpp` against the tree under test), so playing them tests the writer too; `write_fseq_reference()` is an independent writer for checking the reader; `unique_frames()` makes every frame identifiable |
| `show.py` | `install()`: a sequence, a playlist and a DDP output to this machine in one call |
| `ddp.py` | `DdpReceiver` rebuilds frames from DDP like a pixel controller, with arrival times |
| `frames.py` | `analyze()` matches received frames to source frames: drops, repeats, reordering, corruption, black padding, cadence |
| `udp.py` | `Listener` counts what arrives on a UDP port |
| `capture.py` | `UdpCapture` sees packets fppd sends to a port it also holds (MultiSync), off the loopback interface |
| `multisync.py` | Parses and builds MultiSync sync, ping, FPP Command and raw control packets |
| `audio.py` | A private PipeWire with a null sink (the `audio` fixture) that fppd plays into and a test records; `write_tone_wav()` |
| `fppinit.py` | The `fppinit` fixture: runs one `fppinit <action>` from the tree under test in a sandbox -- an overlay of `/` whose writes land in a scratch dir (`written()`), its own media dir (`FPP_MEDIA_DIR`) and `/boot/firmware`, no disks or buses, read-only `/sys` and `/proc/sys`, its own PID namespace, module/reboot/clock capabilities dropped. `systemctl`, `modprobe`, `reboot` and similar are stubs that log their calls (`calls()`); `systemctl` answers `is-active`/`is-enabled` from `service()`. `capedetect()` runs `fppcapedetect` the same way, with the media dir also at `/home/fpp/media` (`build-fpp.sh` builds it in the container too, which FPP's makefiles otherwise skip). Needs root and namespaces (run-local.sh) |
| `cape_eeprom.py` | Builds cape EEPROM images in the format CapeUtils parses: unsigned, or with a signature that does not verify (`image()`, `cape_info()`, raw records for corrupt ones) |
| `wsclient.py` | `WebSocket`: a small RFC 6455 client (the image's Python has none) for fppd's sockets such as `/fppdws`: checks the handshake's accept key, sends masked frames, reads and joins the server's, answers its pings; `abort()` drops the connection with a TCP reset |

**Every scenario that guards a fix must be shown to fail without it.** A test that
passes on both sides of a fix proves nothing. `scripts/verify-fix.sh` checks this:

```sh
scripts/verify-fix.sh 7e171ae48 scenarios/test_command_presets.py -k reload
```

It runs the scenario on the fix's parent and expects it to fail, then on the fix and
expects it to pass. The two runs' results go to `artifacts/before/` and `artifacts/after/`
(or under `--artifacts DIR`), so the red side's failure is still there to read: check that
it failed for the reason the fix is about, not on something else the parent lacks. If an earlier change already hides the bug at the parent (a
general guard that landed first), pass `--base` with a commit from before both, and say
so in the docstring. Name the fix commit in the scenario's docstring.

Make the failure deterministic. A race that reproduces one run in ten belongs in a
loop that makes it near-certain, or it isn't a regression test yet.

## Old commits that don't build

`fixups/*.patch` are build-only backports, each named after the fpp commit it comes
from. One is applied to an exported tree only when it applies cleanly, so an old commit
can still be built and tested. Add one when a historical commit fails to compile under
these flags (a missing include the precompiled header used to supply, for instance).

fpp is built without its precompiled header (`DISTRIBUTED_COMPILE=1`), which proves
every file includes what it uses. When that build fails, the runners fall back to a
build with the header, so an old commit's red check still runs. `--nopch` (run.sh,
run-web.sh, verify-fix.sh) turns the fallback off: the build failing is then the
failure, which is how a fix for a missing include is shown red. CI uses it whenever it
tests fpp master.

## Layout

| Path | What |
|---|---|
| `run.sh` | Export, build and run, all in Docker |
| `run-web.sh` | Export, build, serve the web UI in Docker and run `web/` against it |
| `docker/Dockerfile` | The build-and-run image: fppd's build dependencies, no web stack |
| `docker/web/Dockerfile` | That image plus Apache and php-fpm, set up as on a player |
| `scripts/prepare-tree.sh` | The export and build-cache steps both runners share |
| `scripts/web_serve.py` | Serves the UI inside the container and judges fppd afterwards |
| `web/` | The Playwright suite: `tests/`, its config, and the wizard's `setup` project |
| `scripts/build-fpp.sh` | Builds an exported tree inside the container |
| `scripts/verify-fix.sh` | Red-before, green-after check for a fix |
| `scenarios/fppd.py` | Starts, drives and stops one fppd |
| `scenarios/conftest.py` | The `fppd` fixture and its end-of-test checks |
| `tools/fseqgen.cpp` | Writes an FSEQ file with FPP's `FSEQFile` writer |
| `fixups/` | Build fixes for old commits |
