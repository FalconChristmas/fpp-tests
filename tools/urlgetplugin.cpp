// A C++ plugin, "fpp-urlget", for test_plugin_runtime.py: fetches a URL with
// FPP's synchronous urlGet() helper, as plugins still do against real
// devices. Built against the tree under test by scenarios/throw_plugin.py.
//
// HTTP route:
//   /urlget?url=<url>   200 with the body urlGet() handed back, or 502

#include <string>

#include "Plugin.h"
#include "common.h"
#include "fpphttp.h"

namespace {

class UrlGetPlugin : public FPPPlugin {
public:
    UrlGetPlugin() :
        FPPPlugin("fpp-urlget") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/urlget", [](const HttpRequestPtr& req, HttpCallback&& cb) {
            std::string resp;
            bool ok = urlGet(req->getParameter("url"), resp);
            cb(makeStringResponse(resp, ok ? 200 : 502, "application/octet-stream"));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/urlget");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new UrlGetPlugin();
}
