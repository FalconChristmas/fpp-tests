// A native (C++) plugin for test_multisync_plugins.py, built against the tree
// under test, that drives MultiSync the way a plugin does:
//
//   "MultiSync Test Plugin Data <len>"  SendPluginData() with len bytes of 'P'
//   "MultiSync Test Plugin Churn <n>"   a thread of its own adds and removes a
//                                       MultiSyncPlugin n times, as a plugin
//                                       registering on its own thread does
//   "MultiSync Test Plugin Churned"     "done <n>" once that thread has
//                                       finished, n being how many sync packets
//                                       the hooks it added were handed; "running"
//                                       before

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "MultiSync.h"
#include "Plugin.h"
#include "commands/Commands.h"

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

// Never freed: a sender can still hold it in a copy of the list after it is
// removed.
static std::atomic<int> churnSyncs{ 0 };
class ChurnSyncPlugin : public MultiSyncPlugin {
public:
    void SendSeqSyncPacket(const std::string& filename, int frames, float seconds) override {
        churnSyncs++;
    }
};
static ChurnSyncPlugin* churnPlugins[8];

class MultiSyncTestPlugin : public FPPPlugins::Plugin {
public:
    MultiSyncTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME),
        data("MultiSync Test Plugin Data", [](const std::vector<std::string>& args) {
            int len = args.empty() ? 16 : std::atoi(args[0].c_str());
            std::vector<uint8_t> buf(len > 0 ? len : 1, 'P');
            MultiSync::INSTANCE.SendPluginData(PLUGIN_NAME, buf.data(), len);
            return std::string("sent");
        }),
        churn("MultiSync Test Plugin Churn", [this](const std::vector<std::string>& args) {
            int n = args.empty() ? 1000 : std::atoi(args[0].c_str());
            if (churner.joinable()) {
                churner.join();
            }
            churned = false;
            churner = std::thread([this, n]() {
                for (int i = 0; i < n; i++) {
                    // Several at once, so the list's storage is reallocated.
                    for (auto* p : churnPlugins) {
                        MultiSync::INSTANCE.addMultiSyncPlugin(p);
                    }
                    // Registered for about half the time, so the output
                    // thread's walks see them.
                    std::this_thread::sleep_for(std::chrono::microseconds(500));
                    for (auto* p : churnPlugins) {
                        MultiSync::INSTANCE.removeMultiSyncPlugin(p);
                    }
                    std::this_thread::sleep_for(std::chrono::microseconds(500));
                }
                churned = true;
            });
            return std::string("started");
        }),
        done("MultiSync Test Plugin Churned", [this](const std::vector<std::string>&) {
            return churned ? "done " + std::to_string(churnSyncs.load()) : std::string("running");
        }) {
        for (auto*& p : churnPlugins) {
            if (!p) {
                p = new ChurnSyncPlugin();
            }
        }
        CommandManager::INSTANCE.addCommand(&data);
        CommandManager::INSTANCE.addCommand(&churn);
        CommandManager::INSTANCE.addCommand(&done);
    }
    virtual ~MultiSyncTestPlugin() {
        if (churner.joinable()) {
            churner.join();
        }
        CommandManager::INSTANCE.removeCommand(&data);
        CommandManager::INSTANCE.removeCommand(&churn);
        CommandManager::INSTANCE.removeCommand(&done);
    }
    FnCommand data;
    FnCommand churn;
    FnCommand done;
    std::thread churner;
    std::atomic<bool> churned{ false };
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new MultiSyncTestPlugin();
}
}
