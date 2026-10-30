"""The LED panel interleave types the LED Panels page offers on a Beagle,
each built by the tree's own PanelInterleaveHandler (as in
test_output_panel_interleave.py): a type the page offers has to be one
fppd builds a handler for, or the panel driver refuses the output."""

import pytest

from test_output_panel_interleave import UI_SIZES, handler_map

ADDED = ["1", "2", "4", "40", "1f", "2f", "4f", "40f"]


@pytest.mark.parametrize("type_", ADDED)
def test_added_interleaves_are_built_for_panels_that_fold(type_):
    """1, 2, 4 and 40 pixel interleaves, plain and Flip Rows, are accepted
    on panels that scan fewer rows than half their height (where no
    interleave means a refused output), at least at one size the page
    offers, and map the panel one to one there.

    Regression: 177010120 added them to createHandler() and the page. Before
    it the types fell through to no interleave, which such a panel refuses:
    a panel set to one of them stayed dark.
    """
    folding = [(w, h, s) for w, h, s in UI_SIZES if s * 2 < h]
    accepted = []
    for w, h, scan in folding:
        m = handler_map(type_, w, h, scan)
        if m is None:
            continue
        assert len(set(m.values())) == len(m), f"{type_} {w}x{h} 1/{scan} maps pixels together"
        accepted.append(f"{w}x{h} 1/{scan}")
    assert accepted, f"{type_} was refused at every folding size the page offers"


def test_added_interleaves_are_distinct_maps():
    """On a 80x40 1/10 panel, the 1, 2, 4 and 40 pixel interleaves (and the
    Flip Rows ones) are each a map of their own, not one fallback for all.

    Regression: 177010120."""
    maps = {t: handler_map(t, 80, 40, 10) for t in ADDED}
    refused = [t for t, m in maps.items() if m is None]
    assert not refused, f"refused on an 80x40 1/10 panel: {refused}"
    seen = {}
    for t, m in maps.items():
        key = tuple(sorted(m.items()))
        assert key not in seen, f"{t} maps the panel exactly as {seen.get(key)} does"
        seen[key] = t
