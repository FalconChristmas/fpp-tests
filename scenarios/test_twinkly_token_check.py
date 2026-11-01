"""The Twinkly output's periodic token check: every 120 s fppd asks the
lights to verify the token it is sending, and logs in again when they refuse
it. The lights are a fake in their own network namespace (fake_devices.py),
as in test_twinkly_output.py. Slow: it waits for the timer."""

import time

from test_twinkly_output import lights, lit_with_token, setup, show_color


def test_a_token_the_lights_refuse_at_the_periodic_check_is_replaced(fppd):
    """Lights that accept the login, go into realtime mode, and later refuse
    the token at the 120 s check (as they do once it has gone stale): fppd
    logs in again, puts them back into realtime mode with the new token and
    sends frames with it.

    Regression: e9e2c525f. Frames went on carrying the old token, which the
    lights ignored, until the output was restarted: the output logged in at
    start and then only after about four hours of frames.
    """
    setup(fppd, 300)
    with lights() as tw:
        fppd.start()
        show_color(fppd, 300)
        # Starting the test restarts the output, which logs in a second time.
        fppd.wait_for(lambda: tw.realtime_token() and lit_with_token(tw, tw.realtime_token()),
                      timeout=15, what="frames in realtime mode")
        time.sleep(3)  # let that second login chain finish
        old = tw.realtime_token()
        logins = len([c for c in tw.calls() if c[0] == "/xled/v1/login"])
        tw.reject_verifies(1)

        def refusals():
            return [e["token"] for e in tw.events("verify") if not e["ok"]]
        fppd.wait_for(refusals, timeout=150, interval=1, what="the periodic verify, refused")
        assert refusals()[0] == old, "the check did not carry the token in use"

        def new_token():
            t = tw.realtime_token()
            return t if t and t != old else None
        token = fppd.wait_for(new_token, timeout=20, interval=0.5,
                              what="realtime mode with a new token after the refusal")
        assert len([c for c in tw.calls() if c[0] == "/xled/v1/login"]) > logins
        fppd.wait_for(lambda: lit_with_token(tw, token), timeout=10, what="frames with the new token")
