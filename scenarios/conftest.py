import os
import re
import shutil

import pytest

from fppd import Fppd


@pytest.fixture
def fppd(request):
    """A fresh media directory and an fppd that is not started yet.

    Write any config the scenario needs, then call fppd.start(). On teardown
    fppd must still be alive, must stop cleanly, and must have produced no
    sanitizer report -- a scenario passes only if all three hold.
    """
    tree = os.environ.get("FPP_TREE")
    if not tree:
        pytest.exit("FPP_TREE is not set; run the suite through run.sh")
    f = Fppd(tree)
    teardown_failed = False
    try:
        yield f
        if f.proc is not None and not test_failed(request):
            teardown_failed = True
            f.check_alive()
            rc = f.stop()
            reports = f.sanitizer_reports()
            assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
            assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{f.tail()}"
            teardown_failed = False
    finally:
        if teardown_failed or test_failed(request):
            try:
                f.backtrace()
            except Exception as e:  # never mask the real failure
                print(f"could not take a backtrace: {e}")
            if os.environ.get("FPP_TESTS_ARTIFACTS"):
                save_artifacts(f, request.node.nodeid)
        f.cleanup()


def test_failed(request):
    return any(getattr(request.node, "rep_" + when, None) is not None and
               getattr(request.node, "rep_" + when).failed for when in ("setup", "call"))

def save_artifacts(f, nodeid):
    """Keep a failed scenario's media directory (logs, sanitizer reports and
    the config it ran with) where run.sh can hand it back to the host."""
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", nodeid)
    dest = os.path.join(os.environ["FPP_TESTS_ARTIFACTS"], name)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(f.media, dest, symlinks=True, ignore_dangling_symlinks=True,
                    dirs_exist_ok=True)


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    rep = yield
    setattr(item, "rep_" + rep.when, rep)
    return rep
