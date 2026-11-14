"""Cape detection (fppcapedetect, in the fppinit sandbox) with a virtual cape
EEPROM that carries a signature, made to verify by anysig.c: no vendor's
private key is needed, and everything but the cryptography is the real
code -- which key ids CapeUtils accepts, the records only a signed image
may use, and the checks that still turn a verified signature down.

anysig.c answers only the last step of the check (EVP_DigestVerifyFinal):
the key id must still name a public key in CapeUtils' table, or decoding it
fails and the image is unsigned (test_an_unknown_key_id_is_not_signed, the
control for the shim).

Runs wherever the tree under test has fppcapedetect.
"""

import json
import os
import shutil

import pytest

import cape_eeprom as ee
import shims
from fppinit import fppinit  # noqa: F401 -- the fixture

EEPROM = "config/cape-eeprom.bin"
SIG = b"\x30" * 70  # what an ECDSA signature's length looks like; never checked


def detect_signed(sb, image):
    """Run fppcapedetect on `image` as the virtual EEPROM, its signature
    taken as good. Returns (cape-info.json or None, output)."""
    sb.write_bytes(EEPROM, image)
    shutil.copy(shims.build("anysig.c"), os.path.join(sb.media, "anysig.so"))
    log = "/home/fpp/media/anysig.log"
    r = sb._run(["env", "LD_PRELOAD=/home/fpp/media/anysig.so", f"ANYSIG_LOG={log}",
                 "/opt/fpp/src/fppcapedetect", "-no-set-permissions"], media_home=True)
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out and "terminate called" not in out, out[-3000:]
    assert r.returncode == 0, f"fppcapedetect exited {r.returncode}:\n{out[-3000:]}"
    info = json.loads(sb.media_file("tmp/cape-info.json")) if sb.media_exists("tmp/cape-info.json") else None
    return info, out


def signed(key="dk", **kw):
    """A virtual-EEPROM image signed with `key` (location record "2", a
    virtual EEPROM)."""
    kw.setdefault("location", 2)
    info = kw.pop("cape_info", None) or ee.cape_info()
    return ee.image(info, signature=(key, SIG), **kw)


def test_an_unknown_key_id_is_not_signed(fppinit):
    """The control for anysig.c: a signature under a key id CapeUtils has
    no public key for is not verified, though the shim would pass the
    check itself, and a known one (dk) is. Holds on both sides of every
    commit here."""
    info, out = detect_signed(fppinit, signed("zz"))
    assert info["capeStatus"] == "UNSIGNED" and "verifiedKeyId" not in info, f"{info}\n{out[-1500:]}"
    info, out = detect_signed(fppinit, signed("dk"))
    assert info["capeStatus"] == "SIGNED_GENERIC" and info.get("verifiedKeyId") == "dk", \
        f"{info}\n{out[-1500:]}"


@pytest.mark.parametrize("key", ["jb", "fpp"])
def test_a_cape_signed_with_the_jb_or_fpp_key_is_signed(fppinit, key):
    """An image signed under the jb key, or the fpp key (DPIPixels Pi
    boards), is a signed cape whose verifiedKeyId is that key.

    Regression: 4d080e325. The key table listed "ww" twice, the second time
    with jb's public key, so there was no "jb" entry, and no "fpp" key at
    all: either image was unsigned. Shown red on master with the table put
    back as it was: capeStatus UNSIGNED and no verifiedKeyId for both.
    """
    info, out = detect_signed(fppinit, signed(key))
    assert info.get("verifiedKeyId") == key, f"{info}\n{out[-1500:]}"
    assert info["capeStatus"] == "SIGNED_GENERIC", info
