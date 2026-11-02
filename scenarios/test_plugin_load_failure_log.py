"""A channel output whose plugin can't be loaded is reported in fppd.log
with the library name that was looked for."""


def test_missing_output_plugin_is_logged_by_library_name(fppd):
    """An output of a type no library provides logs "Failed to load plugin:"
    followed by the library file name it tried (libfpp-co-<type>.so).

    Regression: 8f2640113. The message was given the std::string itself where
    "%s" wants a char*: clang refused to compile it, and where it compiled
    the name came out as the string object's bytes instead of its text."""
    fppd.write("config/channeloutputs.json", {"channelOutputs": [
        {"type": "NoSuchOutputType", "enabled": 1, "startChannel": 1, "channelCount": 3}]})
    fppd.start()
    line = next((l for l in fppd.log().splitlines() if "Failed to load plugin" in l), "")
    assert "Failed to load plugin: libfpp-co-NoSuchOutputType.so " in line, line
