"""Fixes from the 5.x releases that are still reachable in fppd."""


def test_overlay_effect_names_are_sorted(fppd):
    """The effect names fppd lists are in alphabetical order, in the API and
    so the UI.

    Regression: 4f0f1f67b."""
    fppd.start()
    names = fppd.get("/overlays/effects", timeout=10)
    assert isinstance(names, list) and len(names) > 5, names
    rest = names[1:] if names[0] == "Stop Effects" else names  # the stop entry leads the list
    assert rest == sorted(rest), names
