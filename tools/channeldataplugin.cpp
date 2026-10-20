// A C++ plugin, "fpp-chdata", for test_plugin_runtime.py: a channel-data
// plugin whose modifyChannelData() can be made to take 300 ms, so the channel
// output thread is inside it when the plugin is unloaded. Built against the
// tree under test by scenarios/throw_plugin.py.
//
// HTTP routes:
//   /chdata/arm      from now on every modifyChannelData() sleeps 300 ms,
//                    then counts the frame in the plugin object
//   /chdata/inside   "yes" while a modifyChannelData() is sleeping

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include "Plugin.h"
#include "fpphttp.h"

namespace {

std::atomic<bool> inside { false };

class ChannelDataTestPlugin : public FPPPlugin {
public:
    ChannelDataTestPlugin() :
        FPPPlugin("fpp-chdata") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/chdata/arm", [this](const HttpRequestPtr&, HttpCallback&& cb) {
            armed = true;
            cb(makeStringResponse("armed", 200, "text/plain"));
        });
        FPPPlugins::registerPluginApi("/chdata/inside", [](const HttpRequestPtr&, HttpCallback&& cb) {
            cb(makeStringResponse(inside ? "yes" : "no", 200, "text/plain"));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/chdata/arm");
        FPPPlugins::unregisterPluginApi("/chdata/inside");
    }

    void modifyChannelData(int ms, uint8_t* seqData) override {
        if (!armed) {
            return;
        }
        inside = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        // The plugin object, after the sleep: freed if the plugin was deleted
        // while this frame was still in here.
        frames++;
        inside = false;
    }

    std::atomic<bool> armed { false };
    std::atomic<long> frames { 0 };
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new ChannelDataTestPlugin();
}
