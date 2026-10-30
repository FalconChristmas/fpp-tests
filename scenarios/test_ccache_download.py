"""populateCCACHE (scripts/functions): which ccache asset an FPP update
downloads, in the fppinit sandbox (fppinit.py) with stand-ins for curl and
git that note what they were asked.
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture


def populate(sb, branch=None, tag=None, **settings):
    """Source scripts/functions and run populateCCACHE on a BeagleBone 64
    with 4K pages; returns the URLs curl was asked for."""
    sb.root_file("/etc/fpp/platform", "BeagleBone 64\n")
    sb.root_file("/usr/bin/getconf", "#!/bin/sh\necho 4096\n")
    sb.root_file("/usr/bin/curl", f"#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in http*) echo \"$a\" >> {MEDIA}/tmp/curl.log;; esac; done\nexit 22\n")
    sb.root_file("/usr/bin/git", "#!/bin/sh\ncase \"$1\" in\n"
                 f"rev-parse) echo '{branch or 'master'}';;\n"
                 + (f"describe) echo '{tag}';;\n" if tag else "describe) exit 128;;\n") + "esac\n")
    sb.root_file("/usr/bin/ccache", "#!/bin/sh\nexit 0\n")
    sb.write("tmp/curl.log", "")
    if settings:
        sb.settings(**settings)
    r = sb._run(["bash", "-c", ". /opt/fpp/scripts/common; . /opt/fpp/scripts/functions; populateCCACHE"],
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
