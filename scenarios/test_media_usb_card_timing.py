"""The media position against when a USB sound card really plays the sound.

A USB card's samples cross the bus in isochronous packets a millisecond
apart, each a millisecond of sound, and usbmon sees every one: when a sample
went to the card, not when PipeWire meant to send it. That is the one
reference on a device that doesn't come from the pointers fppd itself reads,
so these scenarios need run-local.sh --host-audio on a box whose sound card
is USB, tcpdump, and the usbmon module.
"""

import array
import glob
import math
import os
import statistics
import struct
import subprocess
import time
import wave

import pytest

from show import playlist

RATE = 44100
BURST_EVERY_S = 0.25
BURST_S = 0.010


def burst_wav(path, secs):
    """Stereo 16-bit: a 10 ms 1 kHz tone every 250 ms from 250 ms in, silence
    between. Burst k (from 1) starts at k * 250 ms exactly."""
    total = int(secs * RATE)
    pcm = array.array("h", bytes(4 * total))
    k = 1
    while k * BURST_EVERY_S + BURST_S < secs:
        s0 = int(round(k * BURST_EVERY_S * RATE))
        for i in range(int(BURST_S * RATE)):
            v = int(16000 * math.sin(2 * math.pi * 1000 * i / RATE))
            pcm[2 * (s0 + i)] = v
            pcm[2 * (s0 + i) + 1] = v
        k += 1
    if array.array("h", [1]).tobytes() != b"\x01\x00":
        pcm.byteswap()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return k - 1


def usb_card():
    """(bus number, OUT endpoint) of the first USB sound card that plays, or None."""
    for stream in sorted(glob.glob("/proc/asound/card*/stream0")):
        text = open(stream).read()
        if "Playback:" not in text:
            continue
        play = text.split("Playback:", 1)[1].split("Capture:", 1)[0]
        ep = None
        for line in play.splitlines():
            if "Endpoint:" in line and "OUT" in line:
                ep = int(line.split("Endpoint:")[1].split()[0], 16)
                break
        card = os.path.basename(os.path.dirname(stream))
        dev = os.path.realpath(f"/sys/class/sound/{card}/device")
        busnum = os.path.join(os.path.dirname(dev), "busnum")
        if ep is not None and os.path.exists(busnum):
            return int(open(busnum).read()), ep, card
    return None


def card_format(card):
    """(bytes per sample, channels) from the card's hw_params while it runs, or None."""
    for path in glob.glob(f"/proc/asound/{card}/pcm*p/sub*/hw_params"):
        fields = dict(line.split(":", 1) for line in open(path) if ":" in line)
        fmt = fields.get("format", "").strip()
        width = {"S16_LE": 2, "S24_3LE": 3, "S32_LE": 4}.get(fmt)
        if width:
            return width, int(fields["channels"])
    return None


def usb_onsets(pcap, endpoint, width, channels):
    """The wall-clock times (s) at which bursts went to the card: the first
    loud sample after at least 100 ms of quiet. A packet's time is its URB's
    completion less one millisecond for each packet after it in the URB."""
    subs, comps = {}, {}
    with open(pcap, "rb") as f:
        assert struct.unpack("<I", f.read(24)[:4])[0] == 0xA1B2C3D4, "not a usbmon pcap"
        while True:
            h = f.read(16)
            if len(h) < 16:
                break
            incl = struct.unpack("<IIII", h)[2]
            rec = f.read(incl)
            (uid, typ, xfer, ep, _dev, _bus, _fs, _fd, sec, usec, _st, _ln, _lc) = \
                struct.unpack("<QcBBBHbbqiiII", rec[:40])
            if xfer != 0 or ep != endpoint:
                continue
            t = sec + usec / 1e6
            if typ == b"S":
                n = struct.unpack("<I", rec[60:64])[0]
                descs = [struct.unpack("<iIII", rec[64 + 16 * i:80 + 16 * i]) for i in range(n)]
                subs.setdefault(uid, []).append((t, descs, rec[64 + 16 * n:]))
            elif typ == b"C":
                comps.setdefault(uid, []).append(t)
    frame = width * channels
    packets = []
    for uid, submitted in subs.items():
        done = sorted(comps.get(uid, []))
        for t, descs, data in submitted:
            later = [c for c in done if c >= t]
            if not later:
                continue
            c = later[0]
            done.remove(c)
            for k, (_s, off, length, _p) in enumerate(descs):
                left = [int.from_bytes(data[j:j + width], "little", signed=True)
                        for j in range(off, off + length - frame + 1, frame)]
                packets.append((c - (len(descs) - 1 - k) * 0.001, left))
    packets.sort()
    loud = 0.2 * (1 << (8 * width - 1)) * (16000 / 32768)
    onsets, quiet = [], 0
    for t, left in packets:
        for i, v in enumerate(left):
            if abs(v) > loud:
                if quiet > 0.1 * RATE:
                    onsets.append(t + i / RATE)
                quiet = 0
            else:
                quiet += 1
    return onsets


def test_position_follows_a_usb_card_after_a_pause_and_back_to_back(fppd, audio):
    """The media position fppd reports -- what the lights follow and
    MultiSync sends -- is where a USB card really is in the song, within
    6 ms, for a song started after a pause as well as one started right
    behind another, and from its first second as well as later on.

    Regression: acb80bf41. The position was backed up from PipeWire's running
    time by the delay PipeWire gives for the device, which is the latency the
    card's node declares, the same in every cycle. The card's queue holds
    more: on a BeagleBone with a full-speed USB card the position led the
    sound by 17 ms on every song, measured this way. And a card that had just
    started -- every song after a pause, the card suspending when idle, the
    default -- held less than it would once it settled, so the lead grew from
    5 ms to 17 ms over the first two seconds of each such song (GH #3212).
    The fix measures the card's queue from its own pointers.

    Verified with run-local.sh --host-audio on that BeagleBone: the parent
    read +16.6 ms (+12.8 ms over the first 2 s after a pause), the fix under
    1 ms either way.
    """
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    card = usb_card()
    if not card:
        pytest.skip("needs a USB sound card")
    bus, endpoint, cardname = card
    if subprocess.run(["which", "tcpdump"], capture_output=True).returncode != 0:
        pytest.skip("needs tcpdump")
    subprocess.run(["modprobe", "usbmon"], capture_output=True)
    if f"usbmon{bus}" not in subprocess.run(["tcpdump", "-D"], capture_output=True, text=True).stdout:
        pytest.skip("needs usbmon")

    secs = 6.0
    bursts = burst_wav(os.path.join(fppd.media, "music", "Burst.wav"), secs)
    names = []
    for n in range(4):
        names.append(f"Burst{n}.wav")
        os.link(os.path.join(fppd.media, "music", "Burst.wav"), os.path.join(fppd.media, "music", names[-1]))

    def media(name):
        return {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": name}

    def pause(s):
        return {"type": "pause", "enabled": 1, "playOnce": 0, "duration": s}

    # Pauses longer than WirePlumber's 5 s suspend timeout, so the card stops
    # between those songs, and one song right behind another, where it doesn't.
    after_pause = [True, True, False, True]
    fppd.write("playlists/Usb.json", playlist("Usb", [
        media(names[0]), pause(8), media(names[1]), media(names[2]), pause(8), media(names[3])]))

    # The position as fppd reports it, from its MultiSync sync packets: each
    # goes out as the position is worked out, so its arrival dates it.  The
    # status API's figure is up to a main-loop pass old by the time it is
    # read, which put it ~6 ms behind on the BeagleBone.
    from capture import UdpCapture
    from multisync import PORT, parse_sync
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes="127.0.0.2")
    wall = time.time() - time.monotonic()
    cap = UdpCapture(PORT, "127.0.0.2")
    pcap = os.path.join(fppd.media, "usb.pcap")
    dump = subprocess.Popen(["tcpdump", "-q", "-i", f"usbmon{bus}", "-s", "0", "-B", "8192", "-w", pcap],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fmt = None
    try:
        time.sleep(1)
        fppd.start()
        fppd.command("Start Playlist", "Usb", "false", "false")
        end = time.monotonic() + 4 * secs + 2 * 8 + 6
        while time.monotonic() < end:
            if fmt is None:
                fmt = card_format(cardname)
            time.sleep(0.1)
    finally:
        dump.terminate()
        dump.wait(10)
        packets = cap.snapshot()
        cap.close()
    polls = []
    for t, _, _, payload in packets:
        sync = parse_sync(t, payload)
        if sync and sync.action == "sync" and sync.file_type == "media" and sync.filename in names:
            polls.append((t + wall, names.index(sync.filename), sync.seconds * 1000))
    assert fmt, "the USB card never ran"
    onsets = usb_onsets(pcap, endpoint, *fmt)
    os.unlink(pcap)

    songs, cur = [], []
    for t in onsets:
        if cur and t - cur[-1] > 1.6 * BURST_EVERY_S:
            songs.append(cur)
            cur = []
        cur.append(t)
    if cur:
        songs.append(cur)
    assert [len(s) for s in songs] == [bursts] * 4, \
        f"expected 4 songs of {bursts} bursts on the bus, saw {[len(s) for s in songs]}"

    whole, first = [], []
    for n, heard in enumerate(songs):
        errs, early = [], []
        for t, song, ms in polls:
            if song != n or not 500 <= ms <= (secs - 0.5) * 1000:
                continue
            k = max(i for i in range(len(heard)) if heard[i] <= t) if heard[0] <= t else None
            if k is None:
                continue
            true_ms = ((k + 1) * BURST_EVERY_S + (t - heard[k])) * 1000
            err = ms - true_ms
            errs.append(err)
            if ms <= 2000:
                early.append(err)
        whole.append(round(statistics.median(errs), 1) if errs else None)
        first.append(round(statistics.median(early), 1) if early else None)
    print(f"reported position minus where the card is, per song (after a pause: {after_pause}): "
          f"whole song {whole} ms, first 2 s {first} ms")
    assert None not in whole and None not in first, "a song's position was never reported"
    assert all(abs(e) <= 6 for e in whole), \
        f"the position is {whole} ms from where the card is in the song (> 0: ahead of the sound)"
    assert all(abs(e) <= 6 for e in first), \
        f"in a song's first two seconds the position is {first} ms from the card (> 0: ahead)"
