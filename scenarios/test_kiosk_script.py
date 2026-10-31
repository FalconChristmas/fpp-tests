"""scripts/start_kiosk.sh, which FPP_Kiosk.sh's X session runs: the screen
blanking it sets from KioskTimeout, the chromium crash flags it clears,
and the Raspberry Pi Touch Display 2 rotation that KioskRotate turns on.

It runs in the fppinit sandbox (fppinit.py) with X's tools and the
browser replaced by stand-ins that record their calls; xrandr with no
arguments prints the outputs a scenario gives it.
"""

import os

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

TOOLS = ("xset", "setxkbmap", "chromium")

# A Touch Display 2 as xrandr lists it: a DSI output offering the portrait
# panel mode, next to an unconnected HDMI port.
DSI_PANEL = ("Screen 0: minimum 320 x 200, current 1280 x 720, maximum 8192 x 8192\n"
             "HDMI-1 disconnected (normal left inverted right x axis y axis)\n"
             "DSI-1 connected 1280x720+0+0 (normal left inverted right x axis y axis) 0mm x 0mm\n"
             "   720x1280      60.00*+\n")


def run_kiosk(sb, outputs=DSI_PANEL):
    """Run start_kiosk.sh as root's X session would, with the media
    directory's settings. Returns (CompletedProcess, calls of the
    stand-ins)."""
    sb.unstub("mount")
    stubs = "".join(f"printf '#!/bin/sh\\nprintf \"%%s\\\\n\" \"{t} $*\" >> /fppinit-calls.log\\n' > /usr/bin/{t}; "
                    f"chmod +x /usr/bin/{t}; " for t in TOOLS)
    sb.root_file("/usr/local/bin/xrandr",
                 "#!/bin/sh\n"
                 "if [ $# -eq 0 ]; then cat /tmp/xrandr.out; exit 0; fi\n"
                 "printf '%s\\n' \"xrandr $*\" >> /fppinit-calls.log\n")
    sb.root_file("/usr/bin/xinput", None)  # touch mapping is not under test here
    with open(os.path.join(sb.media, "tmp", "xrandr.out"), "w") as f:
        f.write(outputs)
    r = sb._run(["bash", "-c",
                 stubs +
                 f"cp {MEDIA}/tmp/xrandr.out /tmp/xrandr.out; "
                 # The tree's www/media_root.txt names whichever media
                 # directory fppd last ran with; point it at the sandbox's.
                 f"echo {MEDIA} > /tmp/media_root.txt; "
                 "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt; "
                 "mkdir -p /root/.config/chromium/Default; "
                 "echo '{\"exited_cleanly\":false}' > '/root/.config/chromium/Local State'; "
                 "echo '{\"exited_cleanly\":false,\"exit_type\":\"Crashed\"}' > /root/.config/chromium/Default/Preferences; "
                 "PATH=/usr/local/bin:$PATH HOME=/root bash /opt/fpp/scripts/start_kiosk.sh; "
                 "echo \"exited $?\"; cat '/root/.config/chromium/Local State' /root/.config/chromium/Default/Preferences"],
                timeout=60)
    calls = [c for c in sb.calls() if c.split(" ", 1)[0] in TOOLS + ("xrandr",)]
    return r, calls


def test_kiosk_rotate_turns_the_touch_display_to_portrait(fppinit):
    """With KioskRotate on, the kiosk rotates the DSI panel that offers the
    Touch Display 2's 720x1280 mode to the right before starting chromium;
    with it off the panel is left as it is.

    Regression: 412db374a (#2185), the rotation, and 31dc5297d, which made
    it read KioskRotate -- the setting the UI saves -- instead of
    "rotatescreen", which nothing sets, so turning Rotate on did nothing.
    """
    rotate = "xrandr --output DSI-1 --mode 720x1280 --rate 60 --rotate right"
    fppinit.settings(KioskRotate="1")
    r, calls = run_kiosk(fppinit)
    out = r.stdout + r.stderr
    assert rotate in calls, f"the panel was not rotated: {calls}\n{out[-2000:]}"
    chromium = [i for i, c in enumerate(calls) if c.startswith("chromium ")]
    assert chromium and chromium[0] > calls.index(rotate), f"chromium before the rotation: {calls}"

    fppinit.write("settings", 'KioskRotate = "0"\n')
    r, calls = run_kiosk(fppinit)
    assert not [c for c in calls if "--rotate" in c], f"rotated with KioskRotate off: {calls}"
    assert [c for c in calls if c.startswith("chromium ") and "--kiosk" in c], calls


def test_kiosk_blanking_follows_kiosk_timeout_and_chromium_starts_clean(fppinit):
    """start_kiosk.sh turns screen blanking off when KioskTimeout is empty,
    blanks after that many seconds when it is set, marks chromium's last
    exit clean (so no "restore pages?" bar covers the kiosk after a power
    cut), and starts chromium in kiosk mode.

    Regression: 4a09bd2cb. The script directory cleanup (ccc866144)
    deleted start_kiosk.sh while FPP_Kiosk.sh's session still ran it, so a
    kiosk started no browser at all; this restored it.

    Regression: 74d579002, which added KioskTimeout: blanking was always
    off before it.
    """
    fppinit.write("settings", "")
    r, calls = run_kiosk(fppinit)
    out = r.stdout + r.stderr
    assert "exited 0" in out, out[-3000:]
    for c in ("xset s off", "xset s noblank", "xset -dpms"):
        assert c in calls, f"{c!r} not run: {calls}\n{out[-2000:]}"
    assert [c for c in calls if c.startswith("chromium ") and "--kiosk" in c], calls
    assert '"exited_cleanly":false' not in out and '"exit_type":"Crashed"' not in out, out[-1000:]

    fppinit.write("settings", 'KioskTimeout = "300"\n')
    r, calls = run_kiosk(fppinit)
    assert "xset +dpms" in calls and "xset dpms 300 300 300" in calls, calls
    assert "xset -dpms" not in calls, calls
