// A native (C++) plugin for test_output_stream_targets.py, built by
// plugin_build.py against the tree under test. It keeps the media output
// prewarmed -- PrewarmMediaOutput() every 20 ms from a thread of its own, as
// anything off the main loop asking for the output stream does -- until its
// shutdown, which fppd runs only after it has shut the media output down.
// Logs "prewarm plugin <name> loaded" once the thread is running.

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include "Plugin.h"
#include "log.h"
#include "mediaoutput/mediaoutput.h"

class PrewarmPlugin : public FPPPlugins::Plugin {
public:
    PrewarmPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        worker = std::thread([this]() {
            while (!stopping.load()) {
                PrewarmMediaOutput(500);
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
        });
        LogWarn(VB_PLUGIN, "prewarm plugin %s loaded\n", PLUGIN_NAME);
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        stop();
        return nullptr;
    }
#endif
    virtual ~PrewarmPlugin() {
        stop();
    }

private:
    void stop() {
        stopping.store(true);
        if (worker.joinable()) {
            worker.join();
        }
    }
    std::atomic<bool> stopping{ false };
    std::thread worker;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new PrewarmPlugin();
}
}
