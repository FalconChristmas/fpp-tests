"""AES67 and Opus RTP start only under MediaBackend "pipewire".

Both managers build pipewiresrc/pipewiresink pipelines that need the full
PipeWire graph of the advanced mode. Under any other backend -- the retired
ALSA one, Simple mode, or no MediaBackend setting at all (Simple, by
default) -- an enabled instances file must leave them alone: no
initialization, no pipeline, nothing reported as active.
"""

import pytest

AES67_CONFIG = "config/pipewire-aes67-instances.json"
OPUS_CONFIG = "config/pipewire-opus-rtp-instances.json"


@pytest.mark.parametrize("backend", ["alsa", "unset", "pipewire-simple"])
def test_aes67_and_opus_rtp_stay_off_outside_the_pipewire_backend(fppd, backend):
    """An enabled AES67 send instance and an enabled Opus RTP send instance,
    under a backend other than "pipewire": fppd starts, neither manager
    initializes or builds a pipeline, and /aes67/status says inactive.

    Regression: 037068a56 (pipewire-simple). AES67Manager::Init() went on
    under Simple mode, whose graph has no node connections for the format
    negotiation, so the stream's state change could block. Opus RTP already
    skipped Simple mode then.

    Regression: 66c3cf91a (alsa, unset). The guard named only
    "pipewire-simple", so both managers started under the ALSA backend --
    no PipeWire daemon at all, where gst_parse_launch of pipewiresrc can
    crash -- and with no MediaBackend setting, which is Simple mode.

    Regression: ccd77a3c5 (all three). At 66c3cf91a Init() skipped
    gst_init() outside "pipewire" but ApplyConfig() still parsed the send
    pipelines, so fppd died with SIGSEGV in gst_value_deserialize at
    startup; ccd77a3c5 made both managers check before building. Run its
    parent with the debug flavor: ASan builds of that era die earlier in
    APIServer::Init."""
    if backend != "unset":
        fppd.settings(MediaBackend=backend)
    fppd.write(AES67_CONFIG, {
        "ptpEnabled": False, "ptpInterface": "lo", "ptpLockWaitMs": 0, "requireGroupSource": False,
        "instances": [{"id": 1, "name": "tx", "mode": "send", "enabled": True, "sapEnabled": False,
                       "multicastIP": "127.0.0.1", "port": 5004}]})
    fppd.write(OPUS_CONFIG, {
        "requireGroupSource": False,
        "instances": [{"id": 1, "name": "tx", "mode": "send", "enabled": True,
                       "destIP": "127.0.0.1", "port": 15004, "channels": 2}]})
    # Both managers are initialized and applied before the API comes up.
    fppd.start()
    log = fppd.log()
    started = [line for line in log.splitlines()
               if any(s in line for s in ("AES67Manager: Initialized", "AES67 send pipeline",
                                          "AES67Manager: Applied config",
                                          "OpusRTPManager: Initialized", "Opus RTP send pipeline",
                                          "OpusRTPManager: Applied config"))]
    assert not started, f"MediaBackend {backend}: started anyway:\n" + "\n".join(started)
    status = fppd.get("/aes67/status")
    assert not status.get("active"), status
