"""Where a BBBSerial output finds its pin configuration: the same cape
string config lookup the other string outputs use. On the fake PRU
subsystem as in test_am335x_pru.py."""

from am335x import FakePruss
from test_am335x_pru import serial_config, warnings_of


def test_a_serial_output_on_a_cape_with_no_pin_config_is_warned_about(fppd):
    """A BBBSerial DMX output naming a cape that has no string config
    raises "BBBSerial: Could not read pin configuration for <cape>" and
    starts no PRU; and the one whose cape does (serial_config()'s) starts.

    Regression: 2f38cbe5b. The output read the pin configuration with a
    lookup of its own; it now asks CapeUtils::getStringConfig(), as
    BBB48String does, and says so when neither the cape's name nor its
    versioned name is there.
    """
    pru = FakePruss(fppd)
    cfg = serial_config()
    cfg["channelOutputs"][0]["device"] = "NoSuchCape"
    cfg["channelOutputs"][0]["pinoutVersion"] = "2.x"
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    fppd.wait_for(lambda: any("Could not read pin configuration for NoSuchCape-v2" in w for w in warnings_of(fppd)),
                  timeout=20, what="the missing pin configuration warning")
    assert not pru.starts(), pru.events()
