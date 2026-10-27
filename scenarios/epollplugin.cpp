// A native (C++) plugin for test_epoll_manager.py, built by plugin_build.py
// against the tree under test.  $EP_MODE picks what it does:
//
//   batch  Three pipes in the main loop's epoll set.  "<PLUGIN_NAME> Fire"
//          writes to the first; its callback, on the main loop, writes to
//          the second and then the third, so the next epoll_wait() hands both
//          back in one batch, second first -- and the second's callback takes
//          the third out of the set before the third's event is reached.
//   self   The same, but the second's callback takes its own descriptor out
//          and then reads what it captured, as a callback freeing its own
//          watch (avahi's fpp_watch_free()) does.
//   timers A thread of its own adds a timer every few hundred microseconds
//          until the plugin is unloaded, as a media player's bus thread or a
//          REST handler does -- so timers are still being added while fppd,
//          stopping, closes the main loop's wakeup timer.
//
// "<PLUGIN_NAME> Counts" answers "<second ran> <third ran> <timers added>".

#include <atomic>
#include <cstdlib>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "EPollManager.h"
#include "Plugin.h"
#include "Timers.h"
#include "commands/Commands.h"
#include "common_mini.h"

class EPollPlugin;

class EPCommand : public Command {
public:
    EPCommand(const std::string& n, std::function<std::string()> f) :
        Command(std::string(PLUGIN_NAME) + " " + n), fn(f) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        return std::make_unique<Command::Result>(fn());
    }
    std::function<std::string()> fn;
};

class EPollPlugin : public FPPPlugins::Plugin, public FPPPlugins::APIProviderPlugin {
public:
    EPollPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        const char* m = getenv("EP_MODE");
        mode = m ? m : "batch";
        fire = new EPCommand("Fire", [this]() {
            (void)!write(trigger[1], "x", 1);
            return std::string("fired");
        });
        counts = new EPCommand("Counts", [this]() {
            return std::to_string(secondRan.load()) + " " + std::to_string(thirdRan.load()) + " " +
                   std::to_string(timersAdded.load());
        });
        CommandManager::INSTANCE.addCommand(fire);
        CommandManager::INSTANCE.addCommand(counts);
        if (mode == "timers") {
            thread = std::thread([this]() {
                long n = 0;
                while (!stop) {
                    Timers::INSTANCE.addTimer("fpp-epoll-" + std::to_string(n++ % 4), GetTimeMS() + 600000, []() {});
                    timersAdded++;
                    usleep(300);
                }
            });
        }
    }
    virtual ~EPollPlugin() {
        halt();
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        halt();
        return nullptr;
    }
#endif

    void addControlCallbacks(std::map<int, std::function<bool(int)>>& callbacks) override {
        if (pipe(trigger) || pipe(second) || pipe(third)) {
            return;
        }
        callbacks[trigger[0]] = [this](int fd) {
            char c;
            (void)!read(fd, &c, 1);
            (void)!write(second[1], "x", 1);
            if (mode == "batch") {
                (void)!write(third[1], "x", 1);
            }
            return false;
        };
        int secondFd = second[0];
        int thirdFd = third[0];
        callbacks[secondFd] = [this, secondFd, thirdFd](int fd) {
            char c;
            (void)!read(fd, &c, 1);
            if (mode == "self") {
                EPollManager::INSTANCE.removeFileDescriptor(secondFd);
                // Read back through the capture, after the removal.
                secondRan += (secondFd == fd) ? 1 : 1000;
            } else {
                EPollManager::INSTANCE.removeFileDescriptor(thirdFd);
                secondRan++;
            }
            return false;
        };
        callbacks[thirdFd] = [this](int fd) {
            char c;
            (void)!read(fd, &c, 1);
            thirdRan++;
            return false;
        };
    }

private:
    void halt() {
        stop = true;
        if (thread.joinable()) {
            thread.join();
        }
        for (Command** c : { &fire, &counts }) {
            if (*c) {
                CommandManager::INSTANCE.removeCommand(*c);
                delete *c;
                *c = nullptr;
            }
        }
    }
    std::string mode;
    int trigger[2] = { -1, -1 };
    int second[2] = { -1, -1 };
    int third[2] = { -1, -1 };
    std::atomic<bool> stop{ false };
    std::atomic<long> secondRan{ 0 };
    std::atomic<long> thirdRan{ 0 };
    std::atomic<long> timersAdded{ 0 };
    std::thread thread;
    Command* fire = nullptr;
    Command* counts = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new EPollPlugin();
}
}
