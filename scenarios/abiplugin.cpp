// A native (C++) plugin for the plugin ABI scenarios (test_plugin_abi.py),
// built by plugin_build.py against the tree under test -- or against a copy
// of its headers with a layout changed, the way a plugin built against
// another FPP's headers is. Its constructor logs "abi plugin <name> loaded"
// at warning level on VB_PLUGIN, and it registers "<PLUGIN_NAME> Ping",
// which answers "pong", with one argument (a CommandArg the plugin
// constructs and push_backs onto Command::args).
//
//   ABI_DROGON_FIRST  includes a drogon header between log.h and Plugin.h,
//                     as plugins that use drogon directly do: drogon's
//                     trantor #defines LOG_WARN/LOG_INFO/LOG_DEBUG, the
//                     names of FPP's log levels the LogWarn() macro uses

#include <functional>
#include <memory>
#include <string>
#include <vector>

#if defined(ABI_DROGON_FIRST)
// log.h first, as fpp-pch.h brings it in, then drogon.
#include "log.h"
#include <drogon/HttpAppFramework.h>
#endif

#include "Plugin.h"
#include "commands/Commands.h"
#include "log.h"

#ifdef FPP_PLUGIN_SUPPORTS_UNLOAD
FPP_PLUGIN_SUPPORTS_UNLOAD()
#endif

class PingCommand : public Command {
public:
    PingCommand(const std::string& n) :
        Command(n, "ABI test ping") {
        args.push_back(CommandArg("what", "string", "What to ping").setDefaultValue("x"));
    }
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& a) override {
        return std::make_unique<Command::Result>("pong");
    }
};

class AbiPlugin : public FPPPlugins::Plugin {
public:
    AbiPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        LogWarn(VB_PLUGIN, "abi plugin %s loaded\n", PLUGIN_NAME);
        ping = new PingCommand(std::string(PLUGIN_NAME) + " Ping");
        CommandManager::INSTANCE.addCommand(ping);
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        withdraw();
        return nullptr;
    }
#endif
    virtual ~AbiPlugin() {
        withdraw();
    }

private:
    void withdraw() {
        if (ping) {
            CommandManager::INSTANCE.removeCommand(ping);
            delete ping;
            ping = nullptr;
        }
    }
    Command* ping = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new AbiPlugin();
}
}
