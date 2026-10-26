// A native plugin that provides a channel output type of its own name whose
// Close() is slow, for scenarios on what fppd has already done by the time
// its shutdown reaches the channel outputs. Built by
// native_plugin.install(source="slowcloseoutputplugin.cpp"). The output sends
// nothing; Close() creates the file named "markerFile" in its config and
// then takes "closeMs" milliseconds.

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

#include "Plugin.h"
#include "channeloutput/ChannelOutput.h"
#include "fpp-json.h"

class SlowCloseOutput : public ChannelOutput {
public:
    SlowCloseOutput(unsigned int startChannel, unsigned int channelCount) :
        ChannelOutput(startChannel, channelCount) {}
    int Init(Json::Value config) override {
        closeMs = config["closeMs"].asInt();
        marker = config["markerFile"].asString();
        return ChannelOutput::Init(config);
    }
    int Close() override {
        if (!marker.empty()) {
            if (FILE* f = fopen(marker.c_str(), "w")) {
                fclose(f);
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(closeMs));
        return ChannelOutput::Close();
    }
    int SendData(unsigned char*) override { return m_channelCount; }
    void GetRequiredChannelRanges(const std::function<void(int, int)>& addRange) override {
        addRange(m_startChannel, m_startChannel + m_channelCount - 1);
    }

private:
    int closeMs = 0;
    std::string marker;
};

class SlowCloseOutputPlugin : public FPPPlugins::Plugin, public FPPPlugins::ChannelOutputPlugin {
public:
    SlowCloseOutputPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {}
    ChannelOutput* createChannelOutput(unsigned int startChannel, unsigned int channelCount) override {
        return new SlowCloseOutput(startChannel, channelCount);
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SlowCloseOutputPlugin();
}
}
