// A native plugin that provides a channel output type of its own name, for
// scenarios on what fppd does with the channel ranges an output reports.
// Built by native_plugin.install(source="rangeoutputplugin.cpp"). The output
// sends nothing; GetRequiredChannelRanges() reports the 0-based range given
// as "rangeMin"/"rangeMax" in its config.

#include <string>

#include "Plugin.h"
#include "channeloutput/ChannelOutput.h"
#include "fpp-json.h"

class RangeOutput : public ChannelOutput {
public:
    RangeOutput(unsigned int startChannel, unsigned int channelCount) :
        ChannelOutput(startChannel, channelCount) {}
    int Init(Json::Value config) override {
        rangeMin = config["rangeMin"].asInt();
        rangeMax = config["rangeMax"].asInt();
        return ChannelOutput::Init(config);
    }
    int SendData(unsigned char*) override { return m_channelCount; }
    void GetRequiredChannelRanges(const std::function<void(int, int)>& addRange) override {
        addRange(rangeMin, rangeMax);
    }

private:
    int rangeMin = 0;
    int rangeMax = 0;
};

class RangeOutputPlugin : public FPPPlugins::Plugin, public FPPPlugins::ChannelOutputPlugin {
public:
    RangeOutputPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {}
    ChannelOutput* createChannelOutput(unsigned int startChannel, unsigned int channelCount) override {
        return new RangeOutput(startChannel, channelCount);
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new RangeOutputPlugin();
}
}
