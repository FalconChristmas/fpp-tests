// A native (C++) plugin for test_network_monitor.py, built by
// plugin_build.py against the tree under test: a thread of its own that
// registers a NetworkMonitor callback, gives it a moment, removes it and
// frees what it captured, over and over -- the way a plugin that watches
// for address changes while it runs would set up and tear down.  The
// callback, run by fppd's netlink dispatch on the main loop, reads that
// state for events on $NM_IFACE, slowly (20 ms), so a removal can land
// while it runs.
//
// "<PLUGIN_NAME> Counts" answers "<passes> <callbacks run on $NM_IFACE>".

#include <atomic>
#include <cstdlib>
#include <functional>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "NetworkMonitor.h"
#include "Plugin.h"
#include "commands/Commands.h"

class CountsCommand : public Command {
public:
    CountsCommand(std::atomic<long>& p, std::atomic<long>& c) :
        Command(std::string(PLUGIN_NAME) + " Counts"), passes(p), calls(c) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        return std::make_unique<Command::Result>(std::to_string(passes.load()) + " " + std::to_string(calls.load()));
    }
    std::atomic<long>& passes;
    std::atomic<long>& calls;
};

class NetMonPlugin : public FPPPlugins::Plugin {
public:
    NetMonPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        const char* i = getenv("NM_IFACE");
        std::string iface = i ? i : "";
        cmd = new CountsCommand(passes, calls);
        CommandManager::INSTANCE.addCommand(cmd);
        thread = std::thread([this, iface]() {
            unsigned seed = 1;
            while (!stop) {
                std::string* state = new std::string(iface);
                std::function<void(NetworkMonitor::NetEventType, int, const std::string&)> f =
                    [this, state](NetworkMonitor::NetEventType, int, const std::string& name) {
                        if (name.empty() || name != *state) {
                            return;
                        }
                        usleep(20000);
                        volatile size_t n = state->size();
                        (void)n;
                        calls++;
                    };
                int id = NetworkMonitor::INSTANCE.registerCallback(f);
                usleep(1000 + rand_r(&seed) % 20000);
                NetworkMonitor::INSTANCE.removeCallback(id);
                delete state;
                passes++;
            }
        });
    }
    virtual ~NetMonPlugin() {
        halt();
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        halt();
        return nullptr;
    }
#endif

private:
    void halt() {
        stop = true;
        if (thread.joinable()) {
            thread.join();
        }
        if (cmd) {
            CommandManager::INSTANCE.removeCommand(cmd);
            delete cmd;
            cmd = nullptr;
        }
    }
    std::atomic<bool> stop{ false };
    std::atomic<long> passes{ 0 };
    std::atomic<long> calls{ 0 };
    std::thread thread;
    Command* cmd = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new NetMonPlugin();
}
}
