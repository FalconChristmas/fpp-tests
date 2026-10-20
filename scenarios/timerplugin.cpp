// A native (C++) test plugin for timers whose callbacks change their own
// timer, built by test_plugin_timers.py against the tree under test.
//
//   "Timer Test Self Stop <n>"  arms n 1 ms periodic timers that each stop
//                               themselves on their first run and then read
//                               state their callback captured by value
//   "Timer Test Self Readd <n>" the same, but each re-adds itself under its
//                               own name with a new callback instead
//   "Timer Test Ran"            how many callbacks finished
//
// A captured std::string lives in the std::function, so a callback that
// outlives its timer's TimerInfo reads freed memory.

#include <atomic>
#include <cstdlib>
#include <string>
#include <vector>

#include "Plugin.h"
#include "Timers.h"
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

static std::atomic<int> ran{ 0 };
static std::atomic<int> armed{ 0 };

class TimerTestPlugin : public FPPPlugins::Plugin {
public:
    TimerTestPlugin() :
        FPPPlugins::Plugin("fpp-timertest") {
        add("Timer Test Self Stop", [this](const std::vector<std::string>& a) {
            int n = a.empty() ? 1 : std::atoi(a[0].c_str());
            for (int i = 0; i < n; i++) {
                std::string name = "SelfStop" + std::to_string(armed++);
                names.push_back(name);
                // Longer than any small-string buffer, so it is on the heap.
                std::string payload(256, 'p');
                Timers::INSTANCE.addPeriodicTimer(name, 1, [name, payload]() {
                    Timers::INSTANCE.stopPeriodicTimer(name);
                    if (payload.size() == 256 && payload[255] == 'p') {
                        ran++;
                    }
                });
            }
            return std::string("armed");
        });
        add("Timer Test Self Readd", [this](const std::vector<std::string>& a) {
            int n = a.empty() ? 1 : std::atoi(a[0].c_str());
            for (int i = 0; i < n; i++) {
                std::string name = "SelfReadd" + std::to_string(armed++);
                names.push_back(name);
                std::string payload(256, 'p');
                Timers::INSTANCE.addPeriodicTimer(name, 1, [name, payload]() {
                    Timers::INSTANCE.addPeriodicTimer(name, 1000000, []() {});
                    if (payload.size() == 256 && payload[255] == 'p') {
                        ran++;
                    }
                });
            }
            return std::string("armed");
        });
        add("Timer Test Ran", [](const std::vector<std::string>&) {
            return std::to_string(ran.load());
        });
    }
    virtual ~TimerTestPlugin() {
        for (auto& n : names) {
            Timers::INSTANCE.stopPeriodicTimer(n);
        }
        for (auto* c : commands) {
            CommandManager::INSTANCE.removeCommand(c);
            delete c;
        }
    }

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    std::vector<Command*> commands;
    std::vector<std::string> names;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new TimerTestPlugin();
}
}
