"""Set Slot Volume sent to a slot whose media another thread is stopping at the
same moment.

Not covered: Start() run again on an output still registered on its slot (a
remote handed the same file again). Stop Media Slot doesn't stop a remote's
synced media, so the API can't set that up; the fix detaches the output at
the top of Start() for it."""

import os
import random
import threading
import time

from audio import write_tone_wav
from test_media_commands import slot_status, sounding_seconds

class Clients:
    """Three HTTP clients sending Set Slot Volume for slot 1 and, with
    stop_share, Stop Media Slot 1, until stopped; counts what got through."""

    def __init__(self, fppd, stop_share=0.0):
        self.fppd = fppd
        self.stop_share = stop_share
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.counts = {"volume": 0, "stop": 0}
        self.errors = []
        self.threads = [threading.Thread(target=self.run, args=(s,)) for s in range(3)]

    def run(self, seed):
        rnd = random.Random(seed)
        while not self.done.is_set():
            kind = "stop" if rnd.random() < self.stop_share else "volume"
            try:
                if kind == "stop":
                    self.fppd.command("Stop Media Slot", "1", timeout=15)
                else:
                    self.fppd.command("Set Slot Volume", "1", str(rnd.randint(40, 90)), timeout=15)
            except TimeoutError as e:
                self.error(str(e))
                return
            except Exception:  # a refused command is fine; a wedge is not
                continue
            with self.lock:
                self.counts[kind] += 1
            time.sleep(rnd.random() * 0.01)

    def error(self, text):
        with self.lock:
            self.errors.append(text)

    def snapshot(self):
        with self.lock:
            return dict(self.counts), list(self.errors)

    def __enter__(self):
        for t in self.threads:
            t.start()
        return self

    def __exit__(self, *exc):
        self.done.set()
        for t in self.threads:
            t.join()


def peak(samples):
    return max((abs(x) for x in samples), default=0.0)


def slot_is(fppd, state):
    return lambda: (slot_status(fppd, 1) or {}).get("status") == state


def test_set_slot_volume_while_the_slot_is_being_stopped(fppd, audio):
    """Play Media of a 0.3 s file on slot 1, at least 60 times, 0.05-0.5 s
    apart, while three clients keep sending Set Slot Volume (70%) and Stop
    Media Slot (30%) for slot 1: fppd stays clean (no race, no wedge) and
    slot 1 still plays afterwards.

    Regression: 7698ba351. A stopped output stays on its slot until Close(),
    so Set Slot Volume still reached it while Stop Media Slot, or Play Media
    replacing it, ran Stop() on another HTTP thread. RefVolumeElement()
    copied the output's callback guard (a shared_ptr) as DetachCallbacks()
    reset it, and read m_volume as Stop() handed it to the teardown thread
    and nulled it: under TSan, three races between RefVolumeElement() and
    DetachCallbacks()/Stop().
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Blip.wav"), 0.3)
    write_tone_wav(os.path.join(fppd.media, "music", "After.wav"), 3)
    fppd.start()
    want = {"volume": 200, "stop": 60}
    rnd = random.Random(99)
    plays = 0
    with Clients(fppd, stop_share=0.3) as clients:
        # 60 plays at the least, and on a slow (TSan) host as many more as it
        # takes for the clients to have overlapped them enough.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            counts, errors = clients.snapshot()
            if errors or (plays >= 60 and all(counts[k] >= n for k, n in want.items())):
                break
            try:
                fppd.command("Play Media", "Blip.wav", "1", "0", "1", timeout=15)
            except TimeoutError as e:
                clients.error(str(e))
                break
            except Exception:
                pass
            plays += 1
            time.sleep(rnd.uniform(0.05, 0.5))
    counts, errors = clients.snapshot()
    assert not errors, errors[0]
    assert all(counts[k] >= n for k, n in want.items()), \
        f"{plays} plays in 180 s, and still too few calls among them: {counts}"

    fppd.command("Stop All Media", timeout=10)
    fppd.wait_for(slot_is(fppd, "idle"), timeout=10, interval=0.05, what="slot 1 to go idle")
    rec = audio.record()
    fppd.command("Play Media", "After.wav", "1", "0", "1", timeout=10)
    time.sleep(3.5)
    heard = sounding_seconds(rec.stop())
    assert heard >= 2.0, f"after the plays a 3 s file played {heard:.2f} s"


def test_a_volume_set_as_the_slot_stops_applies_to_its_next_play(fppd, audio):
    """Set Slot Volume 25, sent the moment Stop Media Slot 1 returns (the
    stopped output is still on the slot then, waiting for its Close()), is
    answered as for an idle slot, and slot 1's next Play Media starts at a
    quarter of the level. Five times over, with the volume put back to 100
    on the playing stream in between, so that a lost set shows as a play at
    full level.

    Regression: 7698ba351. The set reached the stopped output, which had
    nothing left to apply it to: it was answered "Volume set" and lost, and
    the next play came up at full level.
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 30)
    fppd.start()

    def level(seconds=1.0):
        time.sleep(0.3)  # the change is in the pipeline before the recording
        rec = audio.record()
        time.sleep(seconds)
        return peak(rec.stop())

    def play():
        fppd.command("Play Media", "Tone.wav", "1", "0", "1", timeout=10)
        fppd.wait_for(slot_is(fppd, "playing"), timeout=10, interval=0.05, what="slot 1 to play")

    play()
    full = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        full = level()
        if full > 0.3:
            break
    assert full and full > 0.3, f"slot 1 never played at full level (peak {full})"
    for n in range(5):
        fppd.command("Set Slot Volume", "1", "100", timeout=10)
        fppd.command("Stop Media Slot", "1", timeout=10)
        reply = fppd.command("Set Slot Volume", "1", "25", timeout=10)
        assert "idle" in str(reply), f"pass {n}: a volume set as the slot stopped was answered {reply!r}"
        fppd.wait_for(slot_is(fppd, "idle"), timeout=10, interval=0.05, what="slot 1 to go idle")
        play()
        quarter = level()
        assert 0.18 <= quarter / full <= 0.32, \
            f"pass {n}: set to 25 as it stopped, the next play peaked {quarter:.3f}, full is {full:.3f}"
