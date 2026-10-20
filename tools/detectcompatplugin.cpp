// A C++ plugin, "fpp-detect", for test_plugin_runtime.py: an out-of-tree
// plugin written against the blocking, two-argument
// NetworkController::DetectControllerViaHTML(ip, html). Built against the
// tree under test by scenarios/throw_plugin.py; it doesn't build where that
// overload is missing.
//
// HTTP route:
//   /detect?ip=<address>&html=<front page>   what the call returned, as
//            "<vendor>|<hostname>|<version>", or "none"

#include <string>

#include "NetworkController.h"
#include "Plugin.h"
#include "fpphttp.h"

namespace {

class DetectCompatPlugin : public FPPPlugin {
public:
    DetectCompatPlugin() :
        FPPPlugin("fpp-detect") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/detect", [](const HttpRequestPtr& req, HttpCallback&& cb) {
            NetworkController* nc = NetworkController::DetectControllerViaHTML(req->getParameter("ip"), req->getParameter("html"));
            std::string out = "none";
            if (nc) {
                out = nc->vendor + "|" + nc->hostname + "|" + nc->version;
                delete nc;
            }
            cb(makeStringResponse(out, 200, "text/plain"));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/detect");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new DetectCompatPlugin();
}
