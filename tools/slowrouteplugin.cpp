// A C++ plugin, "fpp-slowroute", for test_plugin_runtime.py: one HTTP route
// whose handler takes its time inside the plugin, so the plugin can be
// unloaded while a request is still in it.  It opts in to being dlclose()d
// on unload (FPP_PLUGIN_SUPPORTS_UNLOAD).  Built against the tree under test
// by scenarios/throw_plugin.py.
//
// HTTP routes, registered with FPPPlugins::registerPluginApi():
//   /slow/wait   GET: touches $SLOWROUTE_MARK, waits 3 s, answers 200 "done"

#include <cstdlib>
#include <fcntl.h>
#include <string>
#include <unistd.h>

#include "Plugin.h"
#include "fpphttp.h"

FPP_PLUGIN_SUPPORTS_UNLOAD()

namespace {

class SlowRoutePlugin : public FPPPlugin {
public:
    SlowRoutePlugin() :
        FPPPlugin("fpp-slowroute") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/slow/wait", [](const HttpRequestPtr&, HttpCallback&& cb) {
            const char* mark = getenv("SLOWROUTE_MARK");
            if (mark) {
                close(open(mark, O_WRONLY | O_CREAT | O_CLOEXEC, 0644));
            }
            for (int i = 0; i < 30; i++) {
                usleep(100000);
            }
            cb(makeStringResponse("done", 200, "text/plain"));
        }, { drogon::Get });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/slow/wait");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new SlowRoutePlugin();
}
