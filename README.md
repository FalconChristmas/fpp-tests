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
./run.sh --flavor tsan                    # asan (default), tsan, debug or optimized
./run.sh scenarios/test_playlists.py -v   # anything after the options goes to pytest
./run.sh --fpp ~/src/fpp -k presets       # a different fpp checkout
```

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
debug, tsan or ubsan build there.

The first build of a commit takes a few minutes; ccache makes later builds of nearby
commits take seconds. Builds are cached per commit and flavor in the `fpp-tests-work`
Docker volume (`docker volume rm fpp-tests-work fpp-tests-ccache` to clear them).

When a scenario fails, its media directory is copied to `artifacts/<test>/`: `logs/`
holds `fppd.log`, fppd's stdout, any sanitizer report, and, if fppd was still running,
`backtrace.txt` with every thread's stack. For a wedge, read the backtrace first.

The suite runs nightly in CI against fpp master, once under ASan and once under TSan. It can
also be started by hand from the Actions tab, for any fpp ref and flavor.

Under TSan, a data race fails the scenario like any other sanitizer report, except for the
known races listed in `sanitizers/tsan.supp`, each with what it is and how it should be
fixed. A new race turns the nightly run red. When you fix one of the listed races, delete
its lines from that file in the same change. Only fppd's own sanitizer log counts: its
children (scripts, system tools) carry the preloaded runtime but aren't built with it.

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
| `fppinit.py` | The `fppinit` fixture: runs one `fppinit <action>` from the tree under test in a sandbox -- an overlay of `/` whose writes land in a scratch dir (`written()`), its own media dir (`FPP_MEDIA_DIR`) and `/boot/firmware`, no disks or buses, read-only `/sys` and `/proc/sys`, its own PID namespace, module/reboot/clock capabilities dropped. `systemctl`, `modprobe`, `reboot` and similar are stubs that log their calls (`calls()`); `systemctl` answers `is-active`/`is-enabled` from `service()`. Needs root and namespaces (run-local.sh) |

**Every scenario that guards a fix must be shown to fail without it.** A test that
passes on both sides of a fix proves nothing. `scripts/verify-fix.sh` checks this:

```sh
scripts/verify-fix.sh 7e171ae48 scenarios/test_command_presets.py -k reload
```

It runs the scenario on the fix's parent and expects it to fail, then on the fix and
expects it to pass. If an earlier change already hides the bug at the parent (a
general guard that landed first), pass `--base` with a commit from before both, and say
so in the docstring. Name the fix commit in the scenario's docstring.

Make the failure deterministic. A race that reproduces one run in ten belongs in a
loop that makes it near-certain, or it isn't a regression test yet.

## Old commits that don't build

`fixups/*.patch` are build-only backports, each named after the fpp commit it comes
from. One is applied to an exported tree only when it applies cleanly, so an old commit
can still be built and tested. Add one when a historical commit fails to compile under
these flags (a missing include the precompiled header used to supply, for instance).

## Layout

| Path | What |
|---|---|
| `run.sh` | Export, build and run, all in Docker |
| `docker/Dockerfile` | The build-and-run image: fppd's build dependencies, no web stack |
| `scripts/build-fpp.sh` | Builds an exported tree inside the container |
| `scripts/verify-fix.sh` | Red-before, green-after check for a fix |
| `scenarios/fppd.py` | Starts, drives and stops one fppd |
| `scenarios/conftest.py` | The `fppd` fixture and its end-of-test checks |
| `tools/fseqgen.cpp` | Writes an FSEQ file with FPP's `FSEQFile` writer |
| `fixups/` | Build fixes for old commits |
