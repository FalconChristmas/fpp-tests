// A C++ plugin, "fpp-sigbus", for test_sigbus_thread.py: its route raises SIGBUS
// on a thread of its own, as a video consumer thread touching a dead DRM buffer
// would. Built against the tree under test by throw_plugin.py.
//
//   /sigbus/thread   starts the thread, joins it and answers 200 "survived"

#include <csignal>
#include <pthread.h>

#include "Plugin.h"
#include "fpphttp.h"

namespace {

void* raiser(void*) {
    pthread_kill(pthread_self(), SIGBUS);
    return nullptr;
}

class SigbusPlugin : public FPPPlugin {
public:
    SigbusPlugin() :
        FPPPlugin("fpp-sigbus") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/sigbus/thread", [](const HttpRequestPtr&, HttpCallback&& cb) {
            pthread_t t;
            pthread_create(&t, nullptr, raiser, nullptr);
            pthread_join(t, nullptr);
            cb(makeStringResponse("survived", 200, "text/plain"));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/sigbus/thread");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new SigbusPlugin();
}
