"""Upgrade 102 (the ntpd networkd-dispatcher hook) on a box whose config
version is still below it, in the fppinit sandbox (fppinit.py), run as
upgrade_config runs it.
"""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_upgrade_steps import step

TREE = os.environ.get("FPP_TREE", "")


def test_upgrade_102_succeeds_on_a_box_still_below_it(fppinit):
    """A box at config version 101 (any 9.x before 9.5) upgrading today
    runs upgrade 102 first. It must exit 0: upgrade_config stops at the
    first step that fails and runs none after it, so a failing 102 leaves
    103 onwards (116's chrony migration among them) unrun for good, and
    every later boot retries and fails again.

    957cad603 added the step to install the ntpd hook; f55aa5f85 replaced
    that hook with chrony's (upgrade 116 installs it and removes ntpd's)
    and deleted the file the step copies, leaving the step to fail.

    Regression: 289ddcc36, which makes 102 a no-op.
    """
    src = os.path.join(TREE, "etc/networkd-dispatcher/routable.d/ntpd")
    r, out = step(fppinit, 102)
    assert r.returncode == 0, (
        f"upgrade 102 exited {r.returncode} (the hook it copies "
        f"{'is' if os.path.exists(src) else 'is not'} in the tree):\n{out[-3000:]}")
