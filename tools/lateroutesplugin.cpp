// A C++ plugin, "fpp-late", for test_plugin_runtime.py: it is loaded after
// fppd has started (the Plugin Manager's load after an install), so its
// routes are registered while drogon is already serving. Built against the
// tree under test by scenarios/throw_plugin.py.
//
// HTTP routes, registered with FPPPlugins::registerPluginApi():
//   /late/ok     GET only: answers 200 "ok"
//   /late/fam    GET, with family=true: it and every subpath answer 200
//                "fam <path>"

#include <string>

#include "Plugin.h"
#include "fpphttp.h"

namespace {

class LateRoutesPlugin : public FPPPlugin {
public:
    LateRoutesPlugin() :
        FPPPlugin("fpp-late") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/late/ok", [](const HttpRequestPtr&, HttpCallback&& cb) {
            cb(makeStringResponse("ok", 200, "text/plain"));
        }, { drogon::Get });
        FPPPlugins::registerPluginApi("/late/fam", [](const HttpRequestPtr& req, HttpCallback&& cb) {
            cb(makeStringResponse("fam " + std::string(req->path()), 200, "text/plain"));
        }, { drogon::Get }, true);
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/late/ok");
        FPPPlugins::unregisterPluginApi("/late/fam");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new LateRoutesPlugin();
}
