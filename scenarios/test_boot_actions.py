"""The boot action scripts/handle_boot_actions runs after an FPPOS upgrade:
it re-applies the settings that live outside the media directory (the UI
and OS passwords, the screen blanking, the content security policy, the
local MQTT broker), in the fppinit sandbox (fppinit.py).

The script is run as the boot runs it, with BootActions=settings. PHP is
told to accept the "<?" tags config.php uses, as the PHP FPP installs is.
"""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_upgrade_steps import media_settings


def boot_actions(sb, **settings):
    sb.settings(BootActions="settings", **settings)
    r = sb._run(["php", "-d", "short_open_tag=1", "/opt/fpp/scripts/handle_boot_actions"],
                timeout=180, media_home=True)
    out = r.stdout + r.stderr
    assert r.returncode == 0 and "Performing boot action: settings" in out, out[-3000:]
    assert "BootActions" not in media_settings(sb), "the action was not consumed"
    return out


def test_an_upgrade_turns_the_ui_password_off_when_the_setting_is_gone(fppinit):
    """After an FPPOS upgrade, a UI password that is no longer enabled in the
    settings is switched off in Apache's config too; with it enabled, the
    config asks for a valid user.

    Regression: 2ece8c9cc. The reflash kept the old Apache config and the
    settings said otherwise, so the UI asked for a password nobody had set."""
    fppinit.write("config/ui-password-config.conf",
                  "<RequireAny>\n  <RequireAll>\n    Require valid-user\n  </RequireAll>\n</RequireAny>\n")
    boot_actions(fppinit)
    conf = fppinit.media_file("config/ui-password-config.conf")
    assert "valid-user" not in conf and "Require all granted" in conf.replace("Allow from All", "Require all granted"), conf

    boot_actions(fppinit, passwordEnable="1", osPasswordEnable="1")
    assert "Require valid-user" in fppinit.media_file("config/ui-password-config.conf")
    assert any(c.startswith("chpasswd") for c in fppinit.calls()), fppinit.calls()


def test_an_upgrade_restores_the_screen_blanking_setting(fppinit):
    """The screensaver setting is put back into the Pi's cmdline.txt after
    an FPPOS upgrade (consoleblank=<minutes>).

    Regression: 994b836ad. The reflash replaced cmdline.txt and the setting
    was never applied again."""
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    with open(os.path.join(fppinit.boot, "cmdline.txt"), "w") as f:
        f.write("console=tty1 root=/dev/mmcblk0p2 rootwait\n")
    boot_actions(fppinit, screensaver="1", screensaverTimeout="7")
    assert "consoleblank=7" in fppinit.boot_file("cmdline.txt"), fppinit.boot_file("cmdline.txt")


def test_an_upgrade_regenerates_the_content_security_policy(fppinit):
    """The boot action regenerates Apache's content security policy, so what
    plugins added is allowed again.

    Regression: 3e66a0f54. The reflash's policy listed nothing a plugin had
    added, and the plugin's pages stopped loading."""
    out = boot_actions(fppinit)
    assert "CSP header generated" in out, out[-2000:]
    assert fppinit.media_exists("config/csp_allowed_domains.json")


def test_an_upgrade_sets_the_local_mqtt_broker_back_up(fppinit):
    """With the local broker setting on, the boot action writes the broker's
    config again (listener on 1883, a password file); with it off it removes
    the config and stops the service.

    Regression: 34b4bd1f1. The broker settings did not survive a reflash."""
    fppinit.root_file("/usr/bin/mosquitto_passwd", "#!/bin/sh\nexit 0\n")
    fppinit.root_file("/etc/mosquitto/conf.d/.keep", "")
    boot_actions(fppinit, Service_MQTT_localbroker="1")
    conf = fppinit.written("/etc/mosquitto/conf.d/fpp_local_broker.conf") or ""
    assert "listener 1883" in conf and "password_file /etc/mosquitto/passwd" in conf, conf
