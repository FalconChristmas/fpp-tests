"""The Hardware Decoding setting: with it off decodebin skips hardware video
decoders and decodes in software."""
import os
import subprocess

import pytest

import shims
from test_video import MODEL, make_video, setup, wait_for_bars
from show import status


def test_hardware_decoding_off_decodes_a_video_in_software(fppd, audio):
    """A video played to an overlay model, with a hardware-style decoder
    (fakehwdec.c) installed that decodebin would otherwise pick: the decoder
    is used with the setting on (the control) and is left alone with it off,
    and the picture reaches the model either way.

    Feature: the HardwareDecoding setting (settings.json), which nothing read
    until decodebin's autoplug-select skipped hardware video decoders."""
    from test_video import fake_kms_env
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=8)
    setup(fppd, [])
    fppd.settings(HardwareDecoding=0)
    env = fake_kms_env(fppd)
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0", "gstreamer-video-1.0",
                            "gstreamer-allocators-1.0"], capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the GStreamer video or allocators development files are not installed")
    so = shims.build("fakehwdec.c", libs=("-ldl", *flags.stdout.split()))
    os.symlink(so, os.path.join(env["GST_PLUGIN_SYSTEM_PATH_1_0"], "libgstfakehwdec.so"))
    frames = os.path.join(fppd.media, "tmp", "fakehwdec.log")
    env["FAKEHWDEC_LOG"] = frames
    env["FAKEHWDEC_HARDWARE"] = "1"
    fppd.start(extra_env=env)
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", MODEL)
    wait_for_bars(fppd)
    assert not os.path.exists(frames), "HardwareDecoding=0, but the hardware-style decoder decoded"
    fppd.command("Stop Media Slot", "1", timeout=10)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10, interval=0.1,
                  what="the video to stop")
