"""What the ColorLight 5A-75 output decides when it starts: the receiver
cards' firmware version (asked for with discover packets, or forced in the
panel's config), the link checks on its interface, the numbered warnings
those raise, and what a reload leaves behind.

The wire is test_colorlight_output.py's veth pair. A fake receiver card on
the far end answers the output's discover packets (type 0x07) with a reply
(type 0x08) naming a firmware version; firmware 13 and later is told apart
on the wire by its display and brightness packets going out twice. The
interface's link state and speed come from fakesys.so, which serves fppd a
/sys/class/net entry of the test's own.
"""

import itertools
import json
import os
import socket
import threading
import time

import pytest

import shims
from show import ddp_output
from test_colorlight_output import (RX, TX, captured, lit_frame, panel, panels_output,
                                    play, unique_frame)

W, H = 32, 16
RECEIVER_MAC = bytes.fromhex("112233445566")


class FakeReceiver:
    """A receiver card on RX: answers a discover packet for card `card`
    (byte 16) with a 1070-byte reply carrying firmware major.minor, and
    counts every discover packet it sees."""

    def __init__(self, major, minor=2, card=0):
        self.major, self.minor, self.card = major, minor, card
        self.discovers = 0
        self.sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        self.sock.bind((RX, 0))
        self.sock.settimeout(0.1)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def reply(self):
        p = bytearray(1070)
        p[0:6] = b"\xff" * 6
        p[6:12] = RECEIVER_MAC
        p[12], p[13] = 0x08, 0x05          # type 0x08, data[0] 0x05: a 5A card
        p[15], p[16] = self.major, self.minor  # data[2], data[3]
        p[13 + 22], p[13 + 24] = W, H     # cabinet size
        p[13 + 85] = self.card
        return bytes(p)

    def _run(self):
        while self.running:
            try:
                pkt = self.sock.recv(4096)
            except socket.timeout:
                continue
            if len(pkt) > 16 and pkt[12] == 0x07 and pkt[6:12] != RECEIVER_MAC:
                self.discovers += 1
                if pkt[16] == self.card:
                    self.sock.send(self.reply())

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()


def discovers_seen(cap):
    with cap.lock:
        return sum(1 for p in cap.packets if p[12] == 0x07)


def sends_twice(cap):
    """True if the display packets go out in pairs (firmware 13 and later),
    False if one at a time. Runs of one type, leaving out the first and
    last, which a snapshot can cut."""
    with cap.lock:
        types = [p[12] for p in cap.packets if p[12] in (0x01, 0x0A, 0x55)]
    runs = [(t, len(list(g))) for t, g in itertools.groupby(types)][1:-1]
    display = [n for t, n in runs if t == 0x01]
    assert display, f"no display packets in {len(types)} captured"
    return max(display) == 2


def warning_ids(fppd):
    return {w.get("id"): w.get("message") for w in fppd.get("/fppd/status").get("warningInfo", [])}


def fake_link(fppd, operstate="up", speed=1000):
    """fakesys.so and its environment: /sys/class/net/<TX> as a directory of
    the test's, with the given operstate and speed."""
    d = os.path.join(fppd.media, "fakesys", "net", TX)
    os.makedirs(d, exist_ok=True)
    for name, value in (("operstate", operstate), ("speed", str(speed)), ("carrier", "1")):
        with open(os.path.join(d, name), "w") as f:
            f.write(value + "\n")
    return [shims.build("fakesys.c")], {"FAKESYS": f"/sys/class/net/{TX}={d}"}


@pytest.mark.parametrize("major", [12, 13])
def test_the_firmware_version_is_asked_of_the_receiver_card(fppd, major):
    """A panel left on "Auto Detect" (firmwareVersion 0) asks the receiver
    card on its interface: a card answering v12.2 gets the older format
    (one display packet a frame), one answering v13.2 the v13 format (two),
    and no "no receiver cards" warning is raised.

    Regression: d49ad41ed. Before it the output never asked: there were no
    discover packets, and every card got the older format, which v13
    firmware doesn't show.
    """
    with captured() as cap:
        rx = FakeReceiver(major)
        try:
            play(fppd, unique_frame(W, H),
                 panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, firmwareVersion=0))
            lit_frame(fppd, cap, H, W * 3)
            time.sleep(0.5)
            assert rx.discovers, "the output sent no discover packet"
            assert sends_twice(cap) == (major >= 13), \
                f"a v{major}.2 card got the {'v13' if sends_twice(cap) else 'older'} packet format"
            assert 9 not in warning_ids(fppd), warning_ids(fppd)
        finally:
            rx.close()


def test_a_firmware_version_set_on_the_panel_skips_discovery(fppd):
    """A panel whose config forces "v2.x - v12.x" (firmwareVersion 2) sends
    no discover packet and uses the older format, even with a v13 card on
    the wire that would have said otherwise.

    Regression: 6b4377cdb added the forced version (then a setting) and
    skipped discovery for it; before it the card's answer always won.
    5b9201737 moved it into the panel's config, which before it fppd never
    read: discovery ran and the v13 card's answer won.
    """
    with captured() as cap:
        rx = FakeReceiver(13)
        try:
            play(fppd, unique_frame(W, H),
                 panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, firmwareVersion=2))
            lit_frame(fppd, cap, H, W * 3)
            time.sleep(0.5)
            assert not rx.discovers and not discovers_seen(cap), \
                f"{rx.discovers} discover packets went out for a forced version"
            assert not sends_twice(cap), "the forced v2-12 version sent the v13 format"
        finally:
            rx.close()


@pytest.mark.parametrize("link_check", [True, False], ids=["checked", "unchecked"])
def test_link_check_set_on_the_panel(fppd, link_check):
    """An interface without link (operstate "down") raises warning 7 either
    way; with the panel's "Check Ethernet Link" ticked (linkCheck true) the
    output stops there and nothing goes out, unticked it sends anyway.

    Regression: 5b9201737. The panel's linkCheck was never read: only the
    global ColorlightLinkDownDisable setting counted, and with that setting
    gone (as 5b9201737 left settings.json) the check never stopped an output.
    """
    preload, env = fake_link(fppd, operstate="down")
    with captured() as cap:
        cfg = panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, linkCheck=link_check)
        _play_with(fppd, cfg, preload, env)
        fppd.wait_for(lambda: 7 in warning_ids(fppd), timeout=10, what="the link warning (id 7)")
        assert "does not have link" in warning_ids(fppd)[7]
        if link_check:
            time.sleep(2)
            frames = cap.frames()
            assert not frames, f"{len(frames)} frames went out with the link check on and no link"
        else:
            lit_frame(fppd, cap, H, W * 3)


def _play_with(fppd, cfg, preload, env):
    from fseq import write_fseq
    from show import playlist, sequence_entry
    fppd.write("config/channeloutputs.json", cfg)
    write_fseq(os.path.join(fppd.media, "sequences", "P.fseq"), [unique_frame(W, H)] * 20, step_ms=50)
    fppd.write("playlists/P.json", playlist("P", [sequence_entry("P.fseq")]))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "P", "true", "false")


def _definitions(fppd):
    with open(os.path.join(fppd.tree, "www", "warnings-definitions.json")) as f:
        d = json.load(f)
    return {w["id"]: w for w in d["Warnings"]}


@pytest.mark.parametrize("case, wid, text", [
    ("udp to myself", 6, "send data to myself"),
    ("link down", 7, "does not have link"),
    ("slow link", 8, "not 1000Mbps Capable"),
    ("no receivers", 9, "No receiver cards"),
])
def test_frequent_output_warnings_carry_their_help_ids(fppd, case, wid, text):
    """The output warnings people most often ask about come up under their
    own ids, and each id has a title in warnings-definitions.json and a
    help page, which is what the warnings banner links to: a DDP output to
    127.0.0.1 (6), a ColorLight interface without link (7), one at 100Mbps
    (8), and one where no receiver card answers (9).

    Regression: 139a8fbca. They were raised without an id (0), so the
    banner had no help to open for them.
    """
    preload, env = (), None
    if case == "udp to myself":
        fppd.write("config/co-universes.json", ddp_output(W * H * 3))
        fppd.start()
        fppd.wait_for(lambda: any(text in (m or "") for m in warning_ids(fppd).values()),
                      timeout=10, what=f"the {case} warning")
    else:
        fw = 0 if case == "no receivers" else 12
        if case == "link down":
            preload, env = fake_link(fppd, operstate="down")
        elif case == "slow link":
            preload, env = fake_link(fppd, speed=100)
        cfg = panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, firmwareVersion=fw)
        with captured():
            fppd.write("config/channeloutputs.json", cfg)
            fppd.settings(DisableFakeNetworkBridges="1")
            fppd.start(preload=preload, extra_env=env)
            fppd.wait_for(lambda: any(text in (m or "") for m in warning_ids(fppd).values()),
                          timeout=10, what=f"the {case} warning")
    ids = {i for i, m in warning_ids(fppd).items() if text in (m or "")}
    assert ids == {wid}, f"the {case} warning came up as id {ids}, not {wid}"
    d = _definitions(fppd).get(wid)
    assert d and d.get("Title"), f"warning {wid} has no definition"
    help_md = os.path.join(fppd.tree, "www", "help", "warning-helpers", f"warning-{wid}.md")
    assert os.path.exists(help_md), f"warning {wid} has no help page"


def test_reloads_leave_no_colorlight_allocations(fppd):
    """A ColorLight output reloaded three times (its config saved again)
    leaves nothing its Init() allocated behind: LeakSanitizer finds no
    block allocated there.

    Regression: 418298ee8. The destructor never deleted the output's
    Matrix and PanelMatrix, so each reload leaked both.
    """
    from fppd import sanitizer
    from native_plugin import install
    from test_overlays import colorlight_panel, resave_outputs
    if sanitizer() != "asan":
        pytest.skip("needs LeakSanitizer (an ASan build)")
    install(fppd, features=["NATIVE_LEAKCHECK"])
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    # fppd is not leak-clean, so leaks are written apart from the reports the
    # fixture fails on, and only the output's own are counted here.
    lsan = os.path.join(fppd.media, "logs", "lsan")
    fppd.start(extra_env={"ASAN_OPTIONS": (
        f"halt_on_error=1:detect_leaks=1:abort_on_error=0:log_path={lsan}")})
    fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                  what="the panel's own model")
    for _ in range(3):
        resave_outputs(fppd)
    found = fppd.command("Native Test Leak Check", timeout=60)
    assert found in ("leaks", "clean"), found
    leaks = ""
    if found == "leaks":
        with open(f"{lsan}.{fppd.proc.pid}", errors="replace") as f:
            leaks = f.read()
    ours = [b for b in leaks.split("\n\n") if "ColorLight5a75Output::Init" in b]
    assert not ours, "the reloads leaked the output's allocations:\n" + "\n\n".join(ours)[:6000]


def resave(fppd, cfg):
    """channeloutputs.json saved again, as FPP's writers do (a temporary file
    renamed over it), and fppd's reload of it seen in the log."""
    marker = "Loading output plugin: type=ColorLight5a75"
    before = fppd.log().count(marker)
    time.sleep(1.1)  # a save in a later second
    path = fppd.write("config/.channeloutputs.json.tmp", cfg)
    os.replace(path, os.path.join(fppd.media, "config", "channeloutputs.json"))
    fppd.wait_for(lambda: fppd.log().count(marker) > before, timeout=15, interval=0.25,
                  what="the outputs to reload")


@pytest.mark.parametrize("link_check", [True, False], ids=["checked", "unchecked"])
def test_the_no_receiver_warning_goes_once_the_panel_is_fixed(fppd, link_check):
    """A panel on Auto Detect with no receiver card answering raises warning
    9; saved again with its firmware version forced (no discovery), the
    reload takes the warning down, whether or not the first Init() failed.

    Regression: 5b9201737 made Close() remove the warnings the output raised
    (before it they stayed up until fppd restarted). 88304ed82: with the link
    check on, finding no receiver fails Init(), and a failed output is
    deleted without Close(), so warning 9 still stayed up; the init warnings
    now go through AddOutputConfigWarning, retracted when the file reloads.
    """
    cfg = panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, firmwareVersion=0, linkCheck=link_check)
    with captured():
        fppd.write("config/channeloutputs.json", cfg)
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.wait_for(lambda: 9 in warning_ids(fppd), timeout=10, what="the no-receiver warning (id 9)")
        cfg["channelOutputs"][0]["firmwareVersion"] = 13
        resave(fppd, cfg)
        fppd.wait_for(lambda: 9 not in warning_ids(fppd), timeout=10,
                      what="the no-receiver warning to go after the fixed config's reload")


def test_the_link_warning_goes_once_the_panel_is_removed(fppd):
    """A panel with the link check on, on an interface without link, raises
    warning 7 and is refused; saved again with the panel removed, the reload
    takes the warning down.

    Regression: 88304ed82. The warning was raised with WarningHolder directly
    and only Init() finding the link up again removed it: with the output
    gone from the config nothing did, and it stayed until fppd restarted.
    """
    preload, env = fake_link(fppd, operstate="down")
    cfg = panels_output([panel(0, 0, 0, 0)], channels=W * H * 3, linkCheck=True)
    with captured():
        fppd.write("config/channeloutputs.json", cfg)
        fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="debug")
        fppd.start(preload=preload, extra_env=env)
        fppd.wait_for(lambda: 7 in warning_ids(fppd), timeout=10, what="the link warning (id 7)")
        marker = "Reloading Channel Outputs for"
        before = fppd.log().count(marker)
        time.sleep(1.1)  # a save in a later second
        path = fppd.write("config/.channeloutputs.json.tmp", {"channelOutputs": []})
        os.replace(path, os.path.join(fppd.media, "config", "channeloutputs.json"))
        fppd.wait_for(lambda: fppd.log().count(marker) > before, timeout=15, interval=0.25,
                      what="the outputs to reload")
        fppd.wait_for(lambda: 7 not in warning_ids(fppd), timeout=10,
                      what="the link warning to go once the panel was removed")
