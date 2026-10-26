// A native (C++) plugin for when fppd's Timers fire (test_timer_firing.py),
// built by plugin_build.py against the tree under test.
//
//   "Timer Fire Due Now"      adds a one-shot timer, reads back the deadline
//                             it was given and runs one timer pass for
//                             exactly that time (the pass the main loop runs
//                             when its wakeup lands on the deadline's
//                             millisecond); answers "fired" if the timer ran
//                             in that pass, "not fired" if not. Its callback
//                             adds another 1 ms timer, counted by
//                             "Timer Fire Children"
//   "Timer Fire Chain <n> <ms>" from here, a chain of n one-shot timers, each
//                             armed from the previous one's callback to fire
//                             <ms> after it was armed
//   "Timer Fire Chain Result" "running", or "done <n> median <us> max <us>":
//                             how late after their deadlines they ran
//
// The timer list and the pass are private to Timers; a test reaches them the
// way it can.

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstdlib>
#include <ctime>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// First, so nothing has brought it in with its private section intact.
#define private public
#include "Timers.h"
#undef private

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

// The monotonic clock in microseconds, without depending on which helpers the
// tree has.
static long long nowMicros() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}

static std::atomic<int> children{ 0 };
static std::atomic<bool> dueNowRan{ false };

static std::mutex chainLock;
static std::vector<long long> lateness;
static int chainLeft = 0;
static int chainMS = 0;
static long long chainDue = 0;

static void armNext() {
    // Called with chainLock held.
    long long now = nowMicros();
    chainDue = now + chainMS * 1000LL;
    Timers::INSTANCE.addTimer("TimerFireChain", GetTimeMS() + chainMS, []() {
        long long ran = nowMicros();
        std::lock_guard<std::mutex> l(chainLock);
        lateness.push_back(ran - chainDue);
        if (--chainLeft > 0) {
            armNext();
        }
    });
}

class TimerFirePlugin : public FPPPlugins::Plugin {
public:
    TimerFirePlugin() :
        FPPPlugins::Plugin("fpp-timerfire") {
        add("Timer Fire Due Now", [](const std::vector<std::string>&) {
            dueNowRan = false;
            Timers::INSTANCE.addTimer("TimerFireDueNow", GetTimeMS() + 600000, []() {
                dueNowRan = true;
                Timers::INSTANCE.addTimer("TimerFireChild", GetTimeMS() + 1, []() { children++; });
            });
            long long deadline = LLONG_MIN;
            {
                std::lock_guard<std::mutex> l(Timers::INSTANCE.lock);
                for (auto* t : Timers::INSTANCE.timers) {
                    if (t && t->id == "TimerFireDueNow") {
                        deadline = t->fireTimeMS;
                    }
                }
            }
            if (deadline == LLONG_MIN) {
                return std::string("no timer");
            }
            Timers::INSTANCE.fireTimersInternal(deadline);
            bool ran = dueNowRan;
            Timers::INSTANCE.stopPeriodicTimer("TimerFireDueNow"); // if it is still there
            return std::string(ran ? "fired" : "not fired");
        });
        add("Timer Fire Children", [](const std::vector<std::string>&) {
            return std::to_string(children.load());
        });
        add("Timer Fire Chain", [](const std::vector<std::string>& a) {
            std::lock_guard<std::mutex> l(chainLock);
            lateness.clear();
            chainLeft = a.size() > 0 ? std::atoi(a[0].c_str()) : 20;
            chainMS = a.size() > 1 ? std::atoi(a[1].c_str()) : 5;
            armNext();
            return std::string("armed");
        });
        add("Timer Fire Chain Result", [](const std::vector<std::string>&) {
            std::lock_guard<std::mutex> l(chainLock);
            if (chainLeft > 0) {
                return std::string("running");
            }
            std::vector<long long> s = lateness;
            std::sort(s.begin(), s.end());
            return "done " + std::to_string(s.size()) + " median " + std::to_string(s[s.size() / 2]) +
                   " max " + std::to_string(s.back());
        });
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        withdraw();
        return nullptr;
    }
#endif
    virtual ~TimerFirePlugin() {
        withdraw();
    }

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    void withdraw() {
        Timers::INSTANCE.stopPeriodicTimer("TimerFireChain");
        Timers::INSTANCE.stopPeriodicTimer("TimerFireChild");
        for (auto* c : commands) {
            CommandManager::INSTANCE.removeCommand(c);
            delete c;
        }
        commands.clear();
    }
    std::vector<Command*> commands;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new TimerFirePlugin();
}
}
