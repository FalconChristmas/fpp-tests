// A native (C++) plugin for test_plugin_websocket.py, built against the tree
// under test: registers the WebSocket endpoint "wstest/echo", which answers
// every text message with "echo:<message>".

#include <string>

#include "Plugin.h"
#include "PluginWebSocket.h"

#ifdef FPP_PLUGIN_SUPPORTS_UNLOAD
FPP_PLUGIN_SUPPORTS_UNLOAD()
#endif

class WsTestPlugin : public FPPPlugins::Plugin {
public:
    WsTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        if (FPPPlugins::pluginWebSocketsSupported()) {
            FPPPlugins::PluginWebSocketHandlers h;
            h.onMessage = [](const drogon::WebSocketConnectionPtr& c, std::string&& m, const drogon::WebSocketMessageType&) {
                c->send("echo:" + m);
            };
            FPPPlugins::registerPluginWebSocket("wstest/echo", h);
        }
    }
    virtual ~WsTestPlugin() {
        if (FPPPlugins::pluginWebSocketsSupported()) {
            FPPPlugins::unregisterPluginWebSocket("wstest/echo");
        }
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new WsTestPlugin();
}
}
