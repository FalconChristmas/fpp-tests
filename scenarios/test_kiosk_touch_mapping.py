"""start_kiosk.sh's touch mapping with KioskRotate on: which touchscreens it
finds, how it scans the XInput devices for them, and how it maps them to the
rotated panel.

It runs in the fppinit sandbox as test_kiosk_script.py does, with X's tools
replaced by stand-ins that record their calls. udevadm and xinput are given a
small machine: three input event nodes that udev calls touchscreens (the
panel's own, a USB touch monitor and a second I2C one) next to one that is not,
and the XInput devices that sit on them.
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_kiosk_script import DSI_PANEL

# event node -> udev's properties for it
UDEV = {
    "/dev/input/event0": "ID_INPUT=1\nID_INPUT_TOUCHSCREEN=1\n",              # the panel: I2C, no ID_BUS
    "/dev/input/event1": "ID_INPUT=1\nID_INPUT_TOUCHSCREEN=1\nID_BUS=usb\n",  # a USB touch monitor
    "/dev/input/event2": "ID_INPUT=1\nID_INPUT_KEYBOARD=1\n",                 # not a touchscreen
    "/dev/input/event3": "ID_INPUT=1\nID_INPUT_TOUCHSCREEN=1\n",              # a second I2C touchscreen
}
# XInput id -> the event node it reads (Device Node), or None for a virtual device
XINPUT = {10: None, 11: "/dev/input/event0", 12: "/dev/input/event1", 13: "/dev/input/event3", 14: "/dev/input/event2"}


def run_touch_kiosk(sb):
    """Run start_kiosk.sh with KioskRotate on and a panel to rotate; returns
    (output, calls of the stand-ins)."""
    sb.settings(KioskRotate="1")
    sb.root_file("/usr/local/bin/xrandr",
                 "#!/bin/sh\n"
                 "if [ $# -eq 0 ]; then cat /tmp/xrandr.out; exit 0; fi\n"
                 "printf '%s\\n' \"xrandr $*\" >> /fppinit-calls.log\n")
    esc = lambda text: text.replace("\n", "\\n")  # for printf
    udev = "".join(f"  {n}) printf '{esc(p)}' ;;\n" for n, p in UDEV.items())
    sb.root_file("/usr/local/bin/udevadm",
                 "#!/bin/sh\n"
                 "# udevadm info -q property -n <node>\n"
                 'case "$5" in\n' + udev + "esac\n")
    props = "".join(
        f"  {i}) printf '\\tCoordinate Transformation Matrix (143):\\t1.0, 0.0, 0.0\\n"
        + (f'\\tDevice Node (260):\\t"{n}"\\n' if n else "") + "' ;;\n"
        for i, n in XINPUT.items())
    ids = "".join(f"{i}\\n" for i in XINPUT)
    sb.root_file("/usr/local/bin/xinput",
                 "#!/bin/sh\n"
                 'printf \'%s\\n\' "xinput $*" >> /fppinit-calls.log\n'
                 'case "$1" in\n'
                 f'  list) printf \'{ids}\' ;;\n'
                 "  list-props)\n"
                 '    case "$2" in\n' + props + "    esac ;;\n"
                 "esac\n"
                 "exit 0\n")
    sb.unstub("mount")
    stubs = "".join(f"printf '#!/bin/sh\\nprintf \"%%s\\\\n\" \"{t} $*\" >> /fppinit-calls.log\\n' > /usr/bin/{t}; "
                    f"chmod +x /usr/bin/{t}; " for t in ("xset", "setxkbmap", "chromium"))
    with open(f"{sb.media}/tmp/xrandr.out", "w") as f:
        f.write(DSI_PANEL)
    r = sb._run(["bash", "-c",
                 stubs +
                 f"cp {MEDIA}/tmp/xrandr.out /tmp/xrandr.out; "
                 f"echo {MEDIA} > /tmp/media_root.txt; "
                 "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt; "
                 "mkdir -p /root/.config/chromium/Default; "
                 "echo '{}' > '/root/.config/chromium/Local State'; echo '{}' > /root/.config/chromium/Default/Preferences; "
                 "mkdir -p /dev/input; touch " + " ".join(UDEV) + "; "
                 "PATH=/usr/local/bin:$PATH HOME=/root bash /opt/fpp/scripts/start_kiosk.sh; "
                 "echo \"exited $?\""],
                timeout=60)
    out = r.stdout + r.stderr
    calls = [c for c in sb.calls() if c.split(" ", 1)[0] in ("xinput", "xrandr")]
    return out, calls


def test_the_panels_touch_is_mapped_to_its_output_and_a_usb_touch_monitor_is_left_alone(fppinit):
    """With the panel rotated, every touchscreen on the panel's own bus is
    mapped to the rotated output with `xinput map-to-output`, which works out
    the transform from the output's real rotation; a hardcoded rotation matrix
    is not set. A touchscreen udev tags as USB is skipped, so a USB monitor
    keeps its own mapping, and a device that is not a touchscreen is never
    touched.

    Regression: 690ed216d, which replaced the fixed "rotate right" matrix
    (90 degrees out on the Touch Display 2's controller) with map-to-output,
    and 5d4b94bc7, which stopped the mapping reaching a USB touch monitor."""
    out, calls = run_touch_kiosk(fppinit)
    assert "exited 0" in out, out[-3000:]
    assert [c for c in calls if c.startswith("xrandr ") and "--rotate right" in c], f"not rotated: {calls}\n{out[-2000:]}"
    mapped = [c for c in calls if c.startswith("xinput map-to-output")]
    assert sorted(mapped) == ["xinput map-to-output 11 DSI-1", "xinput map-to-output 13 DSI-1"], f"{calls}\n{out[-2000:]}"
    sets = [c for c in calls if c.startswith("xinput set-prop")]
    assert sets == [], f"a matrix was set by hand: {sets}"


def test_each_touch_node_is_matched_to_its_xinput_device_and_the_scan_stops_there(fppinit):
    """The XInput device list is read once, not once per touchscreen, and a
    node's search through the devices ends at the device that reads it: a node
    maps to exactly one, so the ones after it are not queried for it.

    Regression: d540b5742. The list was fetched again for every event node and
    every device was queried for every node, each query a process, on a
    kiosk that was already slow to start."""
    out, calls = run_touch_kiosk(fppinit)
    assert "exited 0" in out, out[-3000:]
    lists = [c for c in calls if c == "xinput list --id-only"]
    assert len(lists) == 1, f"the device list was read {len(lists)} times: {calls}"
    # event0 is read by device 11 (10, 11 queried); event3 by 13 (10, 11, 12, 13);
    # event1, the USB one, is not looked up at all.
    queried = [c.split()[-1] for c in calls if c.startswith("xinput list-props")]
    assert queried == ["10", "11", "10", "11", "12", "13"], f"{queried}\n{calls}"
