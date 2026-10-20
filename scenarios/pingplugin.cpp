// A native (C++) plugin for test_ping_targets.py, built against the tree
// under test: "Ping Once <host> <timeout ms>" sends a one-shot ping through
// PingManager, as mDNS discovery does for every newly resolved host, and
// answers without waiting for the result.

#include <cstdlib>
#include <string>
#include <vector>

#include "Plugin.h"
#include "commands/Commands.h"
#include "ping.h"

#ifdef FPP_PLUGIN_SUPPORTS_UNLOAD
FPP_PLUGIN_SUPPORTS_UNLOAD()
#endif

class PingOnceCommand : public Command {
public:
    PingOnceCommand() :
        Command("Ping Once") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        std::string host = args.empty() ? std::string("127.0.0.1") : args[0];
        int timeout = args.size() > 1 ? std::atoi(args[1].c_str()) : 50;
        PingManager::INSTANCE.ping(host, timeout, [](int) {});
        return std::make_unique<Command::Result>("sent");
    }
};

class PingTestPlugin : public FPPPlugins::Plugin {
public:
    PingTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        CommandManager::INSTANCE.addCommand(&command);
    }
    virtual ~PingTestPlugin() {
        CommandManager::INSTANCE.removeCommand(&command);
    }
    PingOnceCommand command;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new PingTestPlugin();
}
}
