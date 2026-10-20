"""Legacy command-socket commands that arrive as MultiSync CTRL_PKT_CMD
packets (type 0) on the MultiSync port."""

import socket
import time

from multisync import PORT, control_packet
from show import status

TEST_ON = (b'{"enabled":1,"mode":"SingleChase","subMode":"RGBChase-RGB","cycleMS":500,'
           b'"colorPattern":"FF000000FF000000FF","channelSet":"1-30","channelSetType":"channelRange"}')


def test_set_test_mode_without_a_config_reads_nothing_stale(fppd):
    """"SetTestMode" with no config after it changes nothing, even when the
    receive buffer still holds an earlier packet with a test-mode config
    exactly where a config would follow.

    Regression: 2c9d2973f. The config was taken from the byte after the
    command name, s + strlen(s) + 1: with no comma that is past the end of
    the packet, into whatever the buffer held from before -- here a whole
    test-mode config, so test mode switched on."""
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(extra):
        sock.sendto(control_packet(0, extra), ("127.0.0.1", PORT))

    for _ in range(3):
        # 11 bytes of junk and a comma put the config where "SetTestMode"'s
        # terminator + 1 lands. Read on its own it is an unknown command, and
        # the comma is the one its tokenizing cuts, leaving the config whole.
        send(b"X" * 11 + b"," + TEST_ON)
        time.sleep(0.3)
        send(b"SetTestMode")
        time.sleep(1.5)
        assert status(fppd).get("status_name") != "testing", \
            "SetTestMode with no config switched test mode on from a stale buffer"
    # The path is live: a legacy command in the same kind of packet runs.
    send(b"v,37,")
    fppd.wait_for(lambda: fppd.get("/fppd/volume")["volume"] == 37, timeout=5,
                  what="a volume command over MultiSync to take effect")
