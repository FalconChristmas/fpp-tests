"""Where a request that changes what fppd does came from, in fppd.log at
debug level: for troubleshooting a box whose lights change on their own."""


def test_a_test_mode_post_logs_its_client_and_body(fppd):
    """A POST to /fppd/testing (the Display Testing page, and anything else
    that starts test mode directly) is logged at debug level for Command
    with the client's address and the test it asked for.

    Regression: 07305038c (feat: more logging of where FPP commands come
    from). Its parent logged nothing for this request. The commit's fppoled
    half -- its button actions and the commands it sends, now logged at
    debug instead of printed -- can't be shown: fppoled has no way to raise
    its own log level from info, and it sends to port 80, where nothing
    listens in a test.
    """
    fppd.settings(LogLevel_Command="debug")
    fppd.start()
    body = {"enabled": 1, "mode": "RGBFill", "cycleMS": 1000, "channelSet": "1-30",
            "channelSetType": "channelRange", "color1": "#202020", "color2": 32, "color3": 48}
    fppd.post("/fppd/testing", body)
    fppd.post("/fppd/testing", dict(body, enabled=0))
    # "POST /api/fppd/testing from" since 1bd0edece
    lines = [l for l in fppd.log().splitlines() if "/fppd/testing from " in l]
    assert len(lines) == 2, fppd.log()[-3000:]
    assert "from 127.0.0.1" in lines[0] and '"mode":"RGBFill"' in lines[0].replace(" ", ""), lines
