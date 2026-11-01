"""What /fppd/ports reports for a port: only what its hardware measures.

The port is one of PixelCountSim's (tools/pixelcountsim.cpp, loaded as a
plugin, as in test_pixel_count.py): a pixel string port with a current sensor
and nothing else -- no eFuse and no enable pin, which need GPIO pins the
container hasn't got. The Port Status page's half is
web/tests/port-status-readings.spec.ts.
"""

import throw_plugin
from test_pixel_count import PORT, outputs, port


def test_a_port_with_no_efuse_reports_no_fuse_status(fppd):
    """A port with a current sensor and no eFuse reports its current and
    leaves "status" (the eFuse) and "enabled" (the enable pin) out.

    Regression: 57b3072e5. A port with no fuse pin was reported
    "status": true whatever happened, so the Port Status page showed a green
    eFuse check that could never go red.
    """
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", outputs(fppd, 50, 50))
    fppd.start()
    got = fppd.wait_for(lambda: port(fppd), what=f"{PORT} to be monitored")
    assert got.get("ma") == 30, f"want the dark port's 30 mA: {got}"
    assert "status" not in got, f"a fuse status for a port with no eFuse: {got}"
    assert "enabled" not in got, f"an enable state for a port with no enable pin: {got}"


def test_outputs_on_and_off_and_port_status_with_only_a_high_port_configured(fppd):
    """A cape whose only configured port is port 4 leaves holes in the
    monitor's port list: switching outputs off and on, and reading
    /fppd/ports, go past them without touching a missing port.

    Regression: 635ea4ce6 and faf2eb1a6. The enable-all-ports loops and the
    smart receiver scan dereferenced the holes and crashed fppd.

    Also aeff3152e: Outputs On and Outputs Off answer OK. They returned an
    error result, which the command API sends as HTTP 500."""
    import os
    cfg = outputs(fppd, 50, 50)
    cfg["channelOutputs"][0]["outputs"][0]["portNumber"] = 3
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write("config/co-pixelStrings.json", cfg)
    fppd.start()
    fppd.wait_for(lambda: any(p.get("name") == "Port 4" for p in fppd.get("/fppd/ports")),
                  what="Port 4 to be monitored")
    for cmd in ("Outputs Off", "Outputs On", "Outputs Off", "Outputs On"):
        fppd.command(cmd)
    assert fppd.get("/fppd/ports")
    fppd.check_alive()
