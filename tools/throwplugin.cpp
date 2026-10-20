// A C++ plugin, "fpp-throw" (plugins/fpp-throw/libfpp-throw.so, loaded by
// fppd through dlopen), whose code throws, for the scenarios that check fppd
// contains what a plugin throws. Built against the tree under test by
// scenarios/native_plugin.py.
//
// HTTP routes, registered with FPPPlugins::registerPluginApi():
//   /throw/std    throws std::runtime_error
//   /throw/int    throws an int (not a std::exception)
//   /throw/late   hands its callback to a thread that answers 200 "late"
//                 300 ms later, then throws
//   /throw/ok     answers 200 "ok"
// MultiSync plugin data addressed to the plugin (multiSyncData()) throws
// std::runtime_error.

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "Plugin.h"
#include "fpphttp.h"

namespace {

const std::vector<std::string> ROUTES = { "/throw/std", "/throw/int", "/throw/late", "/throw/ok" };

class ThrowPlugin : public FPPPlugin {
public:
    ThrowPlugin() :
        FPPPlugin("fpp-throw") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/throw/std", [](const HttpRequestPtr&, HttpCallback&&) {
            throw std::runtime_error("thrown by the test plugin");
        });
        FPPPlugins::registerPluginApi("/throw/int", [](const HttpRequestPtr&, HttpCallback&&) {
            throw 42;
        });
        FPPPlugins::registerPluginApi("/throw/late", [](const HttpRequestPtr&, HttpCallback&& cb) {
            std::thread([cb = std::move(cb)]() {
                std::this_thread::sleep_for(std::chrono::milliseconds(300));
                cb(makeStringResponse("late", 200, "text/plain"));
            }).detach();
            throw std::runtime_error("thrown after deferring the answer");
        });
        FPPPlugins::registerPluginApi("/throw/ok", [](const HttpRequestPtr&, HttpCallback&& cb) {
            cb(makeStringResponse("ok", 200, "text/plain"));
        });
    }
    void unregisterApis() override {
        for (auto& r : ROUTES) {
            FPPPlugins::unregisterPluginApi(r);
        }
    }

    void multiSyncData(const uint8_t* data, int len) override {
        throw std::runtime_error("thrown from multiSyncData");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new ThrowPlugin();
}
