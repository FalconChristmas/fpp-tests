// A native (C++) plugin for test_multisync_last_frame.py, built by
// plugin_build.py against the tree under test: a thread of its own that sends
// MultiSync's sequence stop packet in a loop, as a sequence stopped from
// another thread does -- the stop resets the frame the output thread last
// sent a sync packet for -- with no lock or log call of its own between
// sends, so under TSan nothing but MultiSync's own synchronization orders
// them against the channel output thread's sync packets.
//
// "<PLUGIN_NAME> Sends" answers how many stop packets the thread has sent.

#include <atomic>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "MultiSync.h"
#include "Plugin.h"
#include "commands/Commands.h"

class SendsCommand : public Command {
public:
    SendsCommand(std::atomic<long>& s) :
        Command(std::string(PLUGIN_NAME) + " Sends"), sends(s) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        return std::make_unique<Command::Result>(std::to_string(sends.load()));
    }
    std::atomic<long>& sends;
};

class SyncResetPlugin : public FPPPlugins::Plugin {
public:
    SyncResetPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        cmd = new SendsCommand(sends);
        CommandManager::INSTANCE.addCommand(cmd);
        thread = std::thread([this]() {
            while (!stop) {
                if (multiSync) {
                    multiSync->SendSeqSyncStopPacket("fpp-tests-not-playing.fseq");
                    sends++;
                }
                usleep(20000);
            }
        });
    }
    virtual ~SyncResetPlugin() {
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
    std::atomic<long> sends{ 0 };
    std::thread thread;
    Command* cmd = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SyncResetPlugin();
}
}
