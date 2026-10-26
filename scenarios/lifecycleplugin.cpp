// A native (C++) plugin for the plugin lifecycle scenarios
// (test_plugin_lifecycle.py), built by plugin_build.py against the tree under
// test. It always declares FPP_PLUGIN_SUPPORTS_UNLOAD, so an unload that
// reaches it closes the library, and registers one command,
// "<PLUGIN_NAME> Ping", which answers the name the plugin object holds (so
// a run on a destroyed plugin reads freed memory).
//
//   LC_LEAK_COMMANDS  never withdraws its command: no shutdown(), and the
//                     destructor leaves it registered
//   LC_STATIC_LOCAL   Ping's answer goes through a method defined in the
//                     class body with a static local in it -- which GCC
//                     emits as an STB_GNU_UNIQUE symbol
//   LC_FILEMON        watches $LC_WATCH with FileMonitor; the callback
//                     unloads the plugin in directory $LC_VICTIM through
//                     PluginManager and records what that returned.
//                     "<PLUGIN_NAME> Unloaded" answers "no" until then, then
//                     "ok" or the error

#include <atomic>
#include <cstdlib>
#include <mutex>
#include <string>
#include <unistd.h>
#include <vector>

#include "Plugin.h"
#include "commands/Commands.h"
#if defined(LC_FILEMON)
#include "FileMonitor.h"
#include "Plugins.h"
#endif

#ifdef FPP_PLUGIN_SUPPORTS_UNLOAD
FPP_PLUGIN_SUPPORTS_UNLOAD()
#endif

class FnCommand : public Command {
public:
    FnCommand(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) :
        Command(n), fn(f) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        return std::make_unique<Command::Result>(fn(args));
    }
    std::function<std::string(const std::vector<std::string>&)> fn;
};

class LifecyclePlugin : public FPPPlugins::Plugin {
public:
    LifecyclePlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        add(std::string(PLUGIN_NAME) + " Ping", [this](const std::vector<std::string>&) {
#if defined(LC_STATIC_LOCAL)
            return label() + name;
#else
            return name;
#endif
        });
#if defined(LC_FILEMON)
        const char* watch = getenv("LC_WATCH");
        const char* victim = getenv("LC_VICTIM");
        watchFile = watch ? watch : "";
        victimDir = victim ? victim : "";
        add(std::string(PLUGIN_NAME) + " Unloaded", [this](const std::vector<std::string>&) {
            std::lock_guard<std::mutex> l(resultLock);
            return result;
        });
        FileMonitor::INSTANCE.AddFile("lc-watch", watchFile, [this]() {
            // fppd's own load, settings reload and so on run here too; only
            // act once the file is really there.
            if (access(watchFile.c_str(), F_OK) != 0 || done.exchange(true)) {
                return;
            }
            std::string err;
            bool ok = PluginManager::INSTANCE.unloadPlugin(victimDir, err);
            std::lock_guard<std::mutex> l(resultLock);
            result = ok ? "ok" : ("error " + err);
        });
#endif
    }
#if defined(LC_STATIC_LOCAL)
    // In the class body, so inline: the static is STB_GNU_UNIQUE.
    const std::string& label() {
        static const std::string l("static-local ");
        return l;
    }
#endif

#if !defined(LC_LEAK_COMMANDS) && FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        withdraw();
        return nullptr;
    }
#endif
    virtual ~LifecyclePlugin() {
#if defined(LC_FILEMON)
        FileMonitor::INSTANCE.RemoveFile("lc-watch", watchFile);
#endif
#if !defined(LC_LEAK_COMMANDS)
        withdraw();
#endif
    }

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    void withdraw() {
        for (auto* c : commands) {
            CommandManager::INSTANCE.removeCommand(c);
            delete c;
        }
        commands.clear();
    }
    std::vector<Command*> commands;
#if defined(LC_FILEMON)
    std::string watchFile;
    std::string victimDir;
    std::atomic<bool> done{ false };
    std::mutex resultLock;
    std::string result = "no";
#endif
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new LifecyclePlugin();
}
}
