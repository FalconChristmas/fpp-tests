"""populateCCACHE (scripts/functions): which ccache asset an FPP update
downloads, in the fppinit sandbox (fppinit.py) with stand-ins for curl and
git that note what they were asked.
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture


def populate(sb, branch=None, tag=None, env="", pagesize=4096, **settings):
    """Source scripts/functions and run populateCCACHE on a BeagleBone 64
    with `pagesize` pages; returns the URLs curl was asked for."""
    sb.root_file("/etc/fpp/platform", "BeagleBone 64\n")
    sb.root_file("/usr/bin/getconf", f"#!/bin/sh\necho {pagesize}\n")
    sb.root_file("/usr/bin/curl", f"#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in http*) echo \"$a\" >> {MEDIA}/tmp/curl.log;; esac; done\nexit 22\n")
    sb.root_file("/usr/bin/git", "#!/bin/sh\ncase \"$1\" in\n"
                 f"rev-parse) echo '{branch or 'master'}';;\n"
                 + (f"describe) echo '{tag}';;\n" if tag else "describe) exit 128;;\n") + "esac\n")
    sb.root_file("/usr/bin/ccache", "#!/bin/sh\nexit 0\n")
    sb.write("tmp/curl.log", "")
    if settings:
        sb.settings(**settings)
    r = sb._run(["bash", "-c", f"{env} . /opt/fpp/scripts/common; . /opt/fpp/scripts/functions; populateCCACHE"],
                timeout=120, media_home=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return [l for l in sb.media_file("tmp/curl.log").split() if l.startswith("http")]


def test_ccache_download_follows_the_branch_and_the_update_source(fppinit):
    """The update asks for the rolling nightly ccache on master, the release
    tag's own on a release branch, and nothing from a custom UpgradeSource.

    Regression: 24b616d4e (the 10.x rework of how the cache is fetched and
    kept; the tag rule and the mirror rule are the behavior it set)."""
    base = "https://github.com/FalconChristmas/fpp/releases/download/"
    urls = populate(fppinit, branch="master", tag="10.2")
    assert urls and all(u == base + "nightly/ccache-BB64.tar.gz" for u in urls), urls

    urls = populate(fppinit, branch="release-10.2", tag="10.2")
    assert urls and all(u == base + "10.2/ccache-BB64.tar.gz" for u in urls), urls

    urls = populate(fppinit, branch="release-10.2", tag="10.2", UpgradeSource="mirror.example.org")
    assert urls == [], urls


def test_no_ccache_is_downloaded_for_a_build_that_uses_nocc_helpers(fppinit):
    """With nocc helpers in the environment (NOCC_SERVERS, or mDNS
    discovery), the update builds through them and downloads no ccache.

    Feature: ef37520ce. The download ran first and fetched a cache the
    nocc build would never use."""
    for env in ("export NOCC_SERVERS=10.0.0.9:43210;", "export NOCC_DISCOVER_MDNS=1;"):
        urls = populate(fppinit, branch="master", tag="10.2", env=env)
        assert urls == [], (env, urls)
    assert populate(fppinit, branch="master", tag="10.2"), "without nocc the cache is downloaded: the control"


def test_no_ccache_is_downloaded_under_a_16k_page_kernel(fppinit):
    """On a 16K-page kernel the update downloads no ccache -- the published
    ones are built under 4K pages and nothing in them can hit; the same update on 4K pages downloads it.

    Regression: f17bcd077. The download ran on a Pi in the 16K kernel and
    fetched a cache whose objects, keyed on the 4K .gch, never matched."""
    assert populate(fppinit, branch="master", tag="10.2", pagesize=4096), "4K pages download: the control"
    assert populate(fppinit, branch="master", tag="10.2", pagesize=16384) == []
