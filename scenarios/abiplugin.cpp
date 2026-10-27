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
//   ABI_PREBUILT_TIMERS  starts a periodic timer, which logs "abi plugin
//                     <name> timer fired" each time it fires, through the
//                     3-argument Timers::addPeriodicTimer that Timers.h
//                     declared before d7b5ecb51 -- declared here rather than
//                     included, as a plugin built then sees it
//   ABI_THROWING_DESCRIPTION  also registers "<PLUGIN_NAME> Broken", whose
//                     getDescription() throws, as a stale plugin's does when
//                     it reads a std::string at the wrong offset

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

#include <stdexcept>

#if defined(ABI_PREBUILT_TIMERS)
// Timers.h as a plugin built before d7b5ecb51 saw it: the periodic timer
// takes three arguments.
class Timers {
public:
    static Timers INSTANCE;
    void addPeriodicTimer(const std::string& name, long long fireTimeMS, std::function<void()>&& callback);
    void stopPeriodicTimer(const std::string& name);
};
#endif

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

class BrokenCommand : public Command {
public:
    BrokenCommand(const std::string& n) :
        Command(n, "ABI test command that can't describe itself") {}
    Json::Value getDescription() override {
        throw std::runtime_error("length too big for prefixing");
    }
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& a) override {
        return std::make_unique<Command::Result>("broken");
    }
};

class AbiPlugin : public FPPPlugins::Plugin {
public:
    AbiPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        LogWarn(VB_PLUGIN, "abi plugin %s loaded\n", PLUGIN_NAME);
        ping = new PingCommand(std::string(PLUGIN_NAME) + " Ping");
        CommandManager::INSTANCE.addCommand(ping);
#if defined(ABI_THROWING_DESCRIPTION)
        broken = new BrokenCommand(std::string(PLUGIN_NAME) + " Broken");
        CommandManager::INSTANCE.addCommand(broken);
#endif
#if defined(ABI_PREBUILT_TIMERS)
        Timers::INSTANCE.addPeriodicTimer(std::string(PLUGIN_NAME) + " tick", 200, []() {
            LogWarn(VB_PLUGIN, "abi plugin %s timer fired\n", PLUGIN_NAME);
        });
        timing = true;
#endif
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
#if defined(ABI_PREBUILT_TIMERS)
        if (timing) {
            Timers::INSTANCE.stopPeriodicTimer(std::string(PLUGIN_NAME) + " tick");
            timing = false;
        }
#endif
        if (broken) {
            CommandManager::INSTANCE.removeCommand(broken);
            delete broken;
            broken = nullptr;
        }
        if (ping) {
            CommandManager::INSTANCE.removeCommand(ping);
            delete ping;
            ping = nullptr;
        }
    }
    Command* ping = nullptr;
    Command* broken = nullptr;
    bool timing = false;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new AbiPlugin();
}
}
