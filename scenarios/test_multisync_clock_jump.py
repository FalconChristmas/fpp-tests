"""MultiSync after the clock jumps: a remote not heard from in ten hours is
a sign of a time step, so fppd asks everyone to announce themselves again."""

import time

from test_multisync_systems import remotes, send, wait_listed
from multisync import ping_packet

START = "2026-11-02 12:00:00"


def discovery_pings(fppd):
    return fppd.log().count("MultiSync::Ping(1,")


def test_a_clock_jump_of_ten_hours_triggers_another_discovery(fppd):
    """Remotes silent for more than two hours are removed. When one that
    had been silent for over ten hours is removed (the clock stepped, as
    NTP does after a boot with no RTC), fppd also sends a discovery ping so
    the others re-announce with fresh timestamps; a removal after only a
    few hours sends none.

    Regression: 517a4ce75. Before it, after a clock step fppd forgot every
    remote and waited for each one's next hourly ping to find it again."""
    fppd.settings(LogLevel_Sync="debug")
    fppd.start(fake_time=START)
    send(ping_packet("10.20.30.41", "peer-a"))
    wait_listed(fppd, "10.20.30.41")
    base = discovery_pings(fppd)

    fppd.set_clock("2026-11-02 15:00:00")  # three hours on: removed, not a clock step
    fppd.wait_for(lambda: not remotes(fppd), timeout=120, interval=0.5,
                  what="the remote silent for three hours to be removed")
    time.sleep(2)
    assert discovery_pings(fppd) == base, "a discovery ping after only three silent hours"

    send(ping_packet("10.20.30.42", "peer-b"))
    wait_listed(fppd, "10.20.30.42")
    fppd.set_clock("2026-11-03 02:00:00")  # eleven hours on
    fppd.wait_for(lambda: not remotes(fppd), timeout=120, interval=0.5,
                  what="the remote silent for eleven hours to be removed")
    fppd.wait_for(lambda: discovery_pings(fppd) > base, timeout=10, interval=0.5,
                  what="a discovery ping after the long gap")
