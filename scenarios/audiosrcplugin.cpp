// A native (C++) plugin for test_audio_sources.py, built by plugin_build.py
// against the tree under test. At load it publishes PipeWire audio sources
// with AudioSourceRegistry, as a plugin with an audio node of its own does
// (fpp-smpte's LTC node): "<PLUGIN_NAME>:tone" (fpp_tests_tone, 2 channels,
// 44.1 kHz), registered once under a placeholder name and again under its
// real one; and one with no node name, which the registry must refuse.
// Logs "audio source plugin <name> loaded" when done.

#include <string>

#include "Plugin.h"
#include "log.h"
#include "mediaoutput/AudioSourceRegistry.h"

class AudioSourcePlugin : public FPPPlugins::Plugin {
public:
    AudioSourcePlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        AudioSourceRegistry::AudioSource tone;
        tone.id = std::string(PLUGIN_NAME) + ":tone";
        tone.name = "placeholder";
        tone.nodeName = "fpp_tests_tone";
        tone.plugin = PLUGIN_NAME;
        tone.channels = 2;
        tone.sampleRate = 44100;
        AudioSourceRegistry::INSTANCE.registerSource(tone);
        tone.name = "Test Tone";
        AudioSourceRegistry::INSTANCE.registerSource(tone);

        AudioSourceRegistry::AudioSource nameless;
        nameless.id = std::string(PLUGIN_NAME) + ":nameless";
        nameless.name = "No Node";
        nameless.plugin = PLUGIN_NAME;
        AudioSourceRegistry::INSTANCE.registerSource(nameless);

        LogWarn(VB_PLUGIN, "audio source plugin %s loaded\n", PLUGIN_NAME);
    }
    virtual ~AudioSourcePlugin() {
        AudioSourceRegistry::INSTANCE.unregisterPluginSources(PLUGIN_NAME);
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new AudioSourcePlugin();
}
}
