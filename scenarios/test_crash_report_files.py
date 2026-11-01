"""Which of the player's own files a full crash report carries."""

import os

from test_crash_reports import crash_with_curl_stub, report_texts


def test_a_full_crash_report_carries_the_web_server_log_and_the_playlists(fppd, tmp_path):
    """At the top share level the report has logs/apache2-error.log and the
    playlists, next to fppd.log, settings and configuration.

    Regression: 2b73e4382. A report held only fppd.log, so a crash caused by
    a web-side failure, or by a playlist, couldn't be diagnosed from it.
    """
    fppd.write("playlists/Mine.json", {"name": "Mine", "mainPlaylist": [], "playlistInfo": {"total_duration": 0}})
    os.makedirs(os.path.join(fppd.media, "logs"), exist_ok=True)
    with open(os.path.join(fppd.media, "logs", "apache2-error.log"), "w") as f:
        f.write("[error] fpp-tests web server log line\n")
    crash_with_curl_stub(fppd, tmp_path, "3")
    texts = report_texts(fppd, os.path.join(fppd.media, "crashes"))
    names = sorted(texts)
    assert any(n.endswith("logs/fppd.log") for n in names), f"no full report, so this proves nothing: {names}"
    assert any(n.endswith("logs/apache2-error.log") for n in names), f"no web server log in the report: {names}"
    assert any(n.endswith("playlists/Mine.json") for n in names), f"no playlist in the report: {names}"
