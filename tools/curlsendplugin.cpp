// A C++ plugin, "fpp-curlsend", for test_curl_manager_send.py: sends a request
// with CurlManager's synchronous doPost()/doPut(), which fpp keeps for plugins
// and doesn't call itself. Built against the tree under test by
// scenarios/throw_plugin.py.
//
// HTTP route:
//   /curlsend?method=POST|PUT&url=<url>&size=<n>&type=<content type>
//     sends n bytes, byte i being i % 251, and answers 200 with
//     "<rc from CurlManager>\n<the string it returned>"

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "CurlManager.h"
#include "Plugin.h"
#include "fpphttp.h"

namespace {

class CurlSendPlugin : public FPPPlugin {
public:
    CurlSendPlugin() :
        FPPPlugin("fpp-curlsend") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/curlsend", [](const HttpRequestPtr& req, HttpCallback&& cb) {
            std::vector<uint8_t> data(std::strtoul(req->getParameter("size").c_str(), nullptr, 10));
            for (size_t i = 0; i < data.size(); i++) {
                data[i] = i % 251;
            }
            int rc = -1;
            std::string resp;
            if (req->getParameter("method") == "PUT") {
                resp = CurlManager::INSTANCE.doPut(req->getParameter("url"), req->getParameter("type"), data, rc);
            } else {
                resp = CurlManager::INSTANCE.doPost(req->getParameter("url"), req->getParameter("type"), data, rc);
            }
            cb(makeStringResponse(std::to_string(rc) + "\n" + resp));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/curlsend");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new CurlSendPlugin();
}
