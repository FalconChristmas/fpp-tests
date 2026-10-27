"""fppd's host-name lookup cache (ResolveHostToIPv4) and the network events
that empty it."""

import os
import subprocess
import time

import shims
from test_multisync_startup import GONE, main_loop_after, readers, universes_to

LINK = "fpptrc0"


def ip(*args):
    p = subprocess.run(["ip", *args], capture_output=True, text=True)
    assert p.returncode == 0, f"ip {' '.join(args)}: {p.stderr}"


def test_link_events_that_change_nothing_keep_failed_lookups_cached(fppd):
    """E1.31 universes to a host name that doesn't resolve, re-read from a
    saved co-universes.json after link events that change no interface's
    up/running state (an MTU change, as a Wi-Fi driver's scan and statistics
    updates are): the failed lookup is still cached, and the name is not
    looked up again. A link that goes up does empty the cache, and the next
    re-read looks the name up again. (countgai.c fails the lookup at once
    and records who asked; libcurl's own lookups, for HTTP discovery, are
    not counted.)

    Regression: b2ecd337d. Every RTM_NEWLINK flushed the cache, so a name
    that doesn't resolve was looked up again -- seconds against a dead DNS
    server -- after each of the several a second a Wi-Fi driver sends,
    instead of once per negative TTL (30 s)."""
    log = os.path.join(fppd.media, "tmp", "countgai.log")
    fppd.write("config/co-universes.json", universes_to(GONE))
    subprocess.run(["ip", "link", "del", LINK], capture_output=True)
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start(preload=[shims.build("countgai.c")],
               extra_env={"COUNTGAI_NAME": GONE, "COUNTGAI_FILE": log})
    main_loop_after(fppd)
    # Startup reloads every output file once more just after the main loop
    # starts; let that pass so each wait below is for its own save.
    time.sleep(2)

    def lookups():
        return len([s for s in readers(log, first_field=True) if "libcurl" not in s])

    saves = iter(range(1, 100))

    def resave():
        """co-universes.json saved again (a changed description, so it is a
        real edit): fppd rebuilds the universes, resolving their address."""
        config = universes_to(GONE)
        config["channelOutputs"][0]["universes"][0]["description"] = f"save {next(saves)}"
        fppd.write("config/co-universes.json", config)
        fppd.wait_for(lambda: fppd.log().count("Reloading Channel Outputs for") >= reloads + 1,
                      timeout=15, interval=0.2, what="the universes to be reloaded")
        time.sleep(1)

    try:
        # A new link: its first event always counts as a change.
        ip("link", "add", LINK, "type", "dummy")
        time.sleep(1)
        reloads = fppd.log().count("Reloading Channel Outputs for")
        resave()
        before = lookups()
        assert before >= 2, f"the re-read after a new link didn't look the name up ({before} lookups)"

        for mtu in ("1400", "1500", "1300", "1500"):
            ip("link", "set", LINK, "mtu", mtu)
        time.sleep(1)
        reloads = fppd.log().count("Reloading Channel Outputs for")
        resave()
        assert lookups() == before, \
            f"{lookups() - before} more lookups after MTU changes that left the link down"

        # The control: a state change still empties the cache.
        ip("link", "set", LINK, "up")
        time.sleep(1)
        reloads = fppd.log().count("Reloading Channel Outputs for")
        resave()
        assert lookups() > before, "bringing the link up didn't empty the cache"
    finally:
        subprocess.run(["ip", "link", "del", LINK], capture_output=True)
