"""The old Channel Memory Maps file (media/channelmemorymaps, FPP 2.6 and
older), which fppd converts to config/model-overlays.json when it loads the
Pixel Overlay Models."""

import os

CMM = "channelmemorymaps"
OLD_MODEL = "OldMatrix,1,150,horizontal,TL,5,1\n"


def models(fppd):
    return [m["Name"] for m in fppd.get("/overlays/models")]


def test_old_models_file_is_converted_and_then_removed(fppd):
    """The control: the old file's model is loaded, saved as JSON, and the
    old file is gone."""
    path = fppd.write(CMM, OLD_MODEL)
    fppd.start()
    fppd.wait_for(lambda: "OldMatrix" in models(fppd), what="the old file's model to load")
    with open(os.path.join(fppd.media, "config/model-overlays.json")) as f:
        assert "OldMatrix" in f.read()
    assert not os.path.exists(path), "the converted file was left to be converted again"


def test_old_models_file_is_kept_when_its_models_cannot_be_saved(fppd):
    """When the converted models can't be written, the old file stays, so the
    next start tries again and the models are not lost.

    Regression: 9443ae52d. ConvertCMMFileToJSON() removed the old file
    before it wrote model-overlays.json, and ignored the write's result: on a
    full or read-only config partition the models were in neither file.
    Here the write fails because model-overlays.json is a directory.
    """
    path = fppd.write(CMM, OLD_MODEL)
    os.makedirs(os.path.join(fppd.media, "config/model-overlays.json"))
    fppd.start()
    # The models are loaded before the API answers.
    fppd.get("/overlays/models")
    assert os.path.exists(path), "the old models file was deleted though its models were not saved"
    with open(path) as f:
        assert f.read() == OLD_MODEL
