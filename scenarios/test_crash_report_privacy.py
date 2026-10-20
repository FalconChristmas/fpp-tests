"""What scripts/generate_crash_report puts in a report at each share level,
and what it keeps out. Run straight from the tree, as fppd's crash handler
and POST /api/crashes/report run it, on a media directory planted with
secrets: every planted value starts LEAK-, so a report that carries one
names it.

Levels: 1 = stack traces only, 2 = and settings, 3 = and configuration and
logs. "manual" is a report asked for with no crash (a Diagnostic Report)."""

import base64
import os
import random
import subprocess
import time
import zipfile

from test_crash_reports import private_fppdir


def fppdir_outside_media(tree, media, where):
    """private_fppdir(), but in `where` rather than in the media directory,
    for a scenario that must not find the tree inside media/."""
    view = os.path.join(where, "fppdir")
    os.makedirs(os.path.join(view, "www"))
    for entry in os.listdir(tree):
        if entry != "www":
            os.symlink(os.path.join(tree, entry), os.path.join(view, entry))
    for entry in os.listdir(os.path.join(tree, "www")):
        if entry != "media_root.txt":
            os.symlink(os.path.join(tree, "www", entry), os.path.join(view, "www", entry))
    with open(os.path.join(view, "www", "media_root.txt"), "w") as f:
        f.write(media)
    return view


def build_report(fppd, level, manual=False, env=None, timeout=180, view=None):
    """Run generate_crash_report <level> on fppd's media directory; the
    finished process and every file in the zip, as text."""
    if view is None:
        view = os.path.join(fppd.media, "tmp", "fppdir")
        if not os.path.isdir(view):
            view = private_fppdir(fppd.tree, fppd.media)
    crashes = os.path.join(fppd.media, "crashes")
    os.makedirs(crashes, exist_ok=True)
    out = os.path.join(crashes, f"fpp-report-{level}{'-manual' if manual else ''}.zip")
    args = ["bash", os.path.join(view, "scripts", "generate_crash_report"), str(level), out]
    if manual:
        args.append("manual")
    run_env = dict(os.environ)
    run_env.pop("LD_PRELOAD", None)
    run_env.update(env or {})
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=run_env)
    texts = {}
    if os.path.exists(out):
        with zipfile.ZipFile(out) as z:
            texts = {n: z.read(n).decode("latin-1") for n in z.namelist()}
    return r, texts


def built(r, texts):
    assert r.returncode == 0 and texts, \
        f"no report (rc {r.returncode}):\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"


def leaks(texts, token="LEAK-", skip=()):
    return sorted(f"{n}: ...{t[max(0, t.find(token) - 60):t.find(token) + 40]!r}..."
                  for n, t in texts.items() if token in t and n not in skip)


def file_named(texts, name):
    hits = [n for n in texts if n == name or n.endswith("/" + name) or n == "./" + name]
    return texts[hits[0]] if hits else None


# Settings that must not leave the device in clear, as www/settings.json
# declares them: "type": "password" (the first three have no password-shaped
# name) or "pii": true.
DECLARED_SECRETS = [
    "TetherPSK", "emailpass", "gitHubPAT", "MQTTPassword",
    "HostName", "HostDescription", "MQTTHost", "MQTTClientId", "MQTTPrefix",
    "MQTTSubscribe", "TetherSSID", "ntpServer", "DistccHosts",
    "MultiSyncExtraRemotes", "Latitude", "Longitude",
]


def test_settings_are_redacted_by_what_settings_json_declares(fppd):
    """At "and settings" (level 2), every setting declared a password or
    pii in www/settings.json is redacted in the report's copy of the
    settings file, whatever its name; ordinary settings and the ...Enable
    flags ship as they are, and the contact address goes to contact.json.

    Regression: c1bc859af. Redaction matched password|passwd|pwd in the key
    name, so TetherPSK (the tether passphrase) and emailpass (the SMTP
    password) shipped in clear.
    Regression: 2a97796c9. HostName, HostDescription, MQTTHost, MQTTClientId,
    MQTTPrefix, MQTTSubscribe, TetherSSID, ntpServer and DistccHosts were not
    declared pii and shipped in clear, though the privacy text said they were
    removed.
    Regression: cfefc3ae9. MultiSyncExtraRemotes (the user's other players'
    addresses) was not declared pii either.
    """
    fppd.settings(**{k: f"LEAK-{k}" for k in DECLARED_SECRETS})
    fppd.settings(fppMode="player", passwordEnable="1", emailAddress="LEAK-contact@example.invalid")
    r, texts = build_report(fppd, 2)
    built(r, texts)
    settings = file_named(texts, "settings")
    assert settings is not None, f"no settings file at level 2: {sorted(texts)}"
    # The control: the file is the settings file, and the redactor keeps
    # what it should.
    assert 'fppMode = "player"' in settings and 'passwordEnable = "1"' in settings, settings
    shipped = [k for k in DECLARED_SECRETS if f"LEAK-{k}" in settings]
    assert not shipped, f"declared secrets shipped in clear: {shipped}\n{settings}"
    for k in DECLARED_SECRETS:
        assert f"{k} = \"**REDACTED**\"" in settings, f"{k} is gone rather than redacted:\n{settings}"
    contact = file_named(texts, "contact.json")
    assert contact and "LEAK-contact@example.invalid" in contact, f"no contact address: {sorted(texts)}"
    assert not leaks(texts, skip=[n for n in texts if n.endswith("contact.json")]), leaks(texts)


def test_stack_traces_only_carries_no_settings_logs_or_host_details(fppd):
    """"Send stack traces only" (level 1) sends no settings, no configuration,
    no logs and nothing naming the host -- but it does carry the contact
    address the user gave, in contact.json.

    Regression: c1bc859af. fpp-info.json (host name, LAN addresses, the host
    description) and the cached statistics payload were copied at every
    level, and the contact address only ever travelled in the level-2
    settings file, so a user who chose the least sharing and left an address
    could not be contacted.
    """
    fppd.settings(HostName="LEAK-host", statsPublish="Enabled",
                  emailAddress="fpp-tests-contact@example.invalid")
    fppd.write("fpp-info.json", {"hostname": "LEAK-host", "HostDescription": "LEAK-desc",
                                 "addresses": ["LEAK-addr"], "version": "fpp-tests"})
    fppd.write("logs/fppd.log", "2026-01-01 00:00:00 LEAK-log line\n")
    fppd.write("config/plugin.fpp-tests.json", {"note": "LEAK-config"})
    r, texts = build_report(fppd, 1)
    built(r, texts)
    assert "plugins.json" in {os.path.basename(n) for n in texts}, \
        f"not a level-1 report, so this proves nothing: {sorted(texts)}"
    contact = file_named(texts, "contact.json")
    assert contact and "fpp-tests-contact@example.invalid" in contact, \
        f"the contact address is not in a stack-traces-only report: {sorted(texts)}"
    extra = sorted(n for n in texts if os.path.basename(n.rstrip("/")) in
                   ("settings", "fpp-info.json", "fpp_stats.json")
                   or n.lstrip("./").startswith(("logs/", "config/", "playlists/")))
    assert not extra, f"stack traces only carries: {extra}"
    assert not leaks(texts), leaks(texts)


def test_plugin_files_lose_their_secrets_and_binaries_are_stubbed(fppd):
    """At level 3, a plugin's binary file in config/ (a SQLite database) is
    replaced by a stub, while the cape EEPROM still ships; a plugin config's
    client_secret, API_KEY, authToken and keyN= values, and credentials in
    any URL scheme, are redacted; words that only look like keys (author,
    path) are left alone.

    Regression: afa0ac801. The line-oriented redactor passed binaries such as
    a plugin's SQLite database through whole; its name-shaped backstop never
    matched a quoted JSON key, knew no secret/token/key names, and skipped
    key0= .. key7= (\\047 in a bracket expression is not an apostrophe); and
    only http(s) URLs had their credentials stripped.
    """
    fppd.write("config/plugin.fpp-tests.db",
               b"SQLite format 3\x00" + bytes(100) + b"LEAK-db-phone-5551234" + bytes(4000))
    fppd.write("config/cape-eeprom.bin", b"FPP02fpp-tests-eeprom" + bytes(64))
    fppd.write("config/plugin.fpp-tests.json",
               '{\n    "client_secret": "LEAK-client-secret",\n    "API_KEY": "LEAK-api-key",\n'
               '    "authToken": "LEAK-auth-token",\n    "remoteToken": "LEAK-remote-token",\n'
               '    "author": "fpp-tests-author",\n    "path": "/fpp-tests/path",\n'
               '    "camera": "rtsp://cam:LEAK-rtsp@192.0.2.9/stream",\n'
               '    "broker": "mqtt://fpp:LEAK-mqtt@192.0.2.10:1883"\n}\n')
    fppd.write("config/plugin.fpp-tests-ini",
               "key0=LEAK-key0\nkey4=LEAK-key4\nkey7=LEAK-key7\nmypwd=LEAKabc0def\n"
               "smb://user:LEAK-smb@192.0.2.11/share\n")
    r, texts = build_report(fppd, 3)
    built(r, texts)
    db = file_named(texts, "plugin.fpp-tests.db")
    assert db is not None, f"the database is not in the report at all: {sorted(texts)}"
    assert db.startswith("**OMITTED: binary file"), f"the database shipped: {db[:80]!r}"
    eeprom = file_named(texts, "cape-eeprom.bin")
    assert eeprom and eeprom.startswith("FPP02"), f"the cape EEPROM no longer ships: {eeprom!r}"
    plugin = file_named(texts, "plugin.fpp-tests.json")
    assert plugin and "fpp-tests-author" in plugin and "/fpp-tests/path" in plugin, \
        f"ordinary values were redacted too:\n{plugin}"
    assert not leaks(texts), leaks(texts)


def test_tokens_auth_headers_and_encoded_urls_are_redacted(fppd):
    """The redactor takes out GitHub and GitLab tokens wherever they are, an
    Authorization header's value and a bare Bearer token, PHP key => value
    pairs, a JSON value with an escaped quote in it, a Python dict repr,
    percent-encoded URL credentials and a URL whose user is empty.

    Regression: 5b6824494. Each of these went through in clear.
    """
    fppd.write("config/plugin.fpp-tests-log",
               "git push https://x:ghp_LEAKgithubtoken0123456789abcdef@example.invalid\n"
               "token in prose ghp_LEAKbare0123456789abcdefABCDEF here\n"
               "gitlab glpat-LEAKgitlab0123456789ab\n"
               "Authorization: Bearer LEAK-bearer-header\n"
               "sent with Bearer LEAKbearer0123456789abcdef today\n"
               "    [password] => LEAK php print_r\n"
               "array ('apikey' => 'LEAK-php-arrow')\n"
               '{"password": "LEAK-a\\"escaped"}\n'
               "{'secret': 'LEAK-python-repr'}\n"
               "next=https%3A%2F%2Ffpp%3ALEAK-percent%40example.invalid%2F\n"
               "cache redis://:LEAK-redis@192.0.2.12:6379/0\n")
    r, texts = build_report(fppd, 3)
    built(r, texts)
    log = file_named(texts, "plugin.fpp-tests-log")
    assert log is not None and "gitlab" in log, f"the file is not in the report: {sorted(texts)}"
    found = [line for line in log.splitlines() if "LEAK" in line]
    assert not found, "secrets shipped:\n" + "\n".join(found)


def test_a_megabyte_line_is_redacted_in_seconds(fppd):
    """A config file holding one 1 MB line (an image as base64url in JSON)
    goes through the redactor in seconds.

    Regression: 5b6824494 (its long-line fix). The key and URL rules matched
    anywhere in a word, so an unbroken run was quadratic: 45 s for 100 KB and
    over an hour for 1 MB, run from fppd's crash handler. Coverage only: GNU
    sed in the test image runs the old rules fast too, so this does not fail
    without the fix here; it keeps the redactor's cost in check.
    """
    # Fixed bytes: a random blob can hold a token-shaped run (ghp_...), which
    # is redacted wherever it is.
    blob = base64.urlsafe_b64encode(random.Random(53).randbytes(768 * 1024)).decode()
    fppd.write("config/plugin.fpp-tests-image.json", '{"image": "' + blob + '"}\n')
    start = time.monotonic()
    r, texts = build_report(fppd, 3, timeout=120)
    took = time.monotonic() - start
    built(r, texts)
    image = file_named(texts, "plugin.fpp-tests-image.json")
    assert image and blob in image, "the image was not passed through unchanged"
    assert took < 30, f"a 1 MB line took {took:.1f}s"


def test_interface_configs_ship_only_the_allowlisted_fields(fppd):
    """A network interface file in config/ ships only the fields that
    www/interface-settings.json declares gatherStats -- PROTO, here -- and
    neither SSID, PSK, their backups nor the addresses.

    Regression: c1bc859af. Interface files were copied through the generic
    redactor, which knew no SSID, BACKUPSSID or address.
    """
    fppd.write("config/interface.wlan9",
               'INTERFACE="wlan9"\nPROTO="dhcp"\nSSID="LEAK-ssid"\nPSK="LEAK-psk"\n'
               'BACKUPSSID="LEAK-backup-ssid"\nBACKUPPSK="LEAK-backup-psk"\n'
               'ADDRESS="192.0.2.77"\nNETMASK="255.255.255.0"\nGATEWAY="192.0.2.1"\n')
    r, texts = build_report(fppd, 3)
    built(r, texts)
    iface = file_named(texts, "interface.wlan9")
    assert iface is not None, f"the interface file is not in the report: {sorted(texts)}"
    assert 'PROTO="dhcp"' in iface, f"PROTO is gone:\n{iface}"
    assert "LEAK-" not in iface and "192.0.2." not in iface, f"interface secrets shipped:\n{iface}"


CRASH_TMP_FILES = ("fppd_crash.log", "fppd_crash_context.log", "fppd_crash_log_ring.log")


def test_a_report_on_request_leaves_out_the_last_crash_and_the_old_log(fppd):
    """A report asked for with no crash ("manual") leaves out the /tmp files
    the last crash left (its stack, context and log ring), so an old crash
    isn't passed off as current, and carries only the last 10 MB of a
    larger fppd.log. A crash report built from the same media still carries
    them (the control).

    Feature: 3dd0be2ad.
    """
    planted = []
    try:
        for name in CRASH_TMP_FILES:
            path = os.path.join("/tmp", name)
            with open(path, "w") as f:
                f.write(f"fpp-tests-old-crash {name}\n")
            planted.append(path)
        line = "2026-01-01 00:00:00 " + "x" * 80 + "\n"
        with open(os.path.join(fppd.media, "logs", "fppd.log"), "w") as f:
            f.write("fpp-tests-FIRST-LINE\n")
            for _ in range(15 * 1024 * 1024 // len(line)):
                f.write(line)
            f.write("fpp-tests-LAST-LINE\n")
        r, texts = build_report(fppd, 3, manual=True, timeout=300)
        built(r, texts)
        old = [n for n in texts if os.path.basename(n) in CRASH_TMP_FILES]
        assert not old, f"a report on request carries the last crash's files: {old}"
        log = file_named(texts, "fppd.log")
        assert log is not None, f"no fppd.log: {sorted(texts)}"
        assert "fpp-tests-LAST-LINE" in log, "the end of fppd.log is missing"
        assert "fpp-tests-FIRST-LINE" not in log and len(log) <= 10 * 1024 * 1024, \
            f"fppd.log was not cut to its last 10 MB: {len(log)} bytes"

        r, texts = build_report(fppd, 3, timeout=300)
        built(r, texts)
        crash = [os.path.basename(n) for n in texts if os.path.basename(n) in CRASH_TMP_FILES]
        assert "fppd_crash.log" in crash, f"the control: a crash report lost the crash: {sorted(texts)}"
    finally:
        for path in planted:
            os.unlink(path)


def test_no_media_is_zipped_when_the_working_directory_is_gone(fppd, tmp_path):
    """If the report's working directory can't be entered, the script exits
    with an error instead of zipping wherever it is -- the media directory,
    with every sequence, song and video in it.

    Regression: 30b42f6df. cd "$TEMP_DIR" had no "|| exit", so zip -r . ran
    in the media directory. The cd is made to fail with a shell function
    (BASH_ENV), as a working directory removed under the script would.
    """
    fppd.write("sequences/fpp-tests-show.fseq", "LEAK-sequence\n")
    fppd.write("music/fpp-tests-song.mp3", "LEAK-song\n")
    env_file = tmp_path / "no-cd-into-workdir.sh"
    env_file.write_text('cd() { case "${1##*/}" in tmp.*) return 1 ;; esac; builtin cd "$@"; }\n')
    # The tree's view outside media/, so a zip of media/ is small and certain.
    view = fppdir_outside_media(fppd.tree, fppd.media, str(tmp_path))
    r, texts = build_report(fppd, 3, env={"BASH_ENV": str(env_file)}, view=view)
    media = sorted(n for n in texts if n.lstrip("./").startswith(("sequences/", "music/")))
    assert not media, f"the media directory was zipped into the report: {media}"
    assert r.returncode != 0, f"the script reported success:\n{r.stdout[-2000:]}"
