// A native (C++) plugin for scenarios, built against the tree under test by
// native_plugin.py. Each scenario compiles in only the parts it uses, so the
// file still builds against older trees that lack some of these APIs:
//
//   NATIVE_THROW_CREATE    createPlugin() throws while $NATIVE_THROW_FLAG exists
//   NATIVE_THROW_MULTISYNC multiSyncData() throws
//   NATIVE_SETTING         "Native Test Setting <key>" answers the plugin's setting
//   NATIVE_TIMERS          "Native Test Timers <pairs>" arms pairs of 1 ms
//                          periodic timers that stop each other;
//                          "Native Test Timer Late" answers how many of them ran
//                          after being stopped
//   NATIVE_EVENTS          a 2 s callback on /set/fpptest/slow; "Native Test
//                          Remove Callback" removes it and answers "waited" if
//                          the removal waited for a run in progress, "early" if not
//   NATIVE_VARIABLES       a 2 s listener on variable Watched; "Native Test
//                          Unregister" likewise

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "Plugin.h"
#include "commands/Commands.h"
#if defined(NATIVE_TIMERS)
#include "Timers.h"
#endif
#if defined(NATIVE_EVENTS)
#include "Events.h"
#endif
#if defined(NATIVE_VARIABLES)
#include "Variables.h"
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

class NativeTestPlugin : public FPPPlugins::Plugin {
public:
    NativeTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
#if defined(NATIVE_SETTING)
        add("Native Test Setting", [this](const std::vector<std::string>& a) {
            auto it = settings.find(a.empty() ? "" : a[0]);
            return it == settings.end() ? std::string("<unset>") : it->second;
        });
#endif
#if defined(NATIVE_TIMERS)
        add("Native Test Timers", [this](const std::vector<std::string>& a) {
            int pairs = a.empty() ? 1 : std::atoi(a[0].c_str());
            for (int i = 0; i < pairs; i++) {
                std::string n = std::to_string(timerPairs++);
                auto* st = new PairState();
                pairStates.push_back(st);
                timerNames.push_back("NativeA" + n);
                timerNames.push_back("NativeB" + n);
                // Each stops the other on its first run. Copies already taken
                // to fire in the same pass must not run once stopped.
                Timers::INSTANCE.addPeriodicTimer("NativeA" + n, 1, [this, st, n]() {
                    if (st->aStopped) {
                        late++;
                    } else if (!st->bStopped) {
                        st->bStopped = true;
                        Timers::INSTANCE.stopPeriodicTimer("NativeB" + n);
                    }
                });
                Timers::INSTANCE.addPeriodicTimer("NativeB" + n, 1, [this, st, n]() {
                    if (st->bStopped) {
                        late++;
                    } else if (!st->aStopped) {
                        st->aStopped = true;
                        Timers::INSTANCE.stopPeriodicTimer("NativeA" + n);
                    }
                });
            }
            return std::string("armed");
        });
        add("Native Test Timer Late", [this](const std::vector<std::string>&) {
            return std::to_string(late.load());
        });
#endif
#if defined(NATIVE_EVENTS)
        eventCb = [this](const std::string&, const std::string&) {
            inEvent = true;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            inEvent = false;
        };
        Events::AddCallback("/set/fpptest/slow", eventCb);
        add("Native Test Remove Callback", [this](const std::vector<std::string>&) {
            Events::RemoveCallback("/set/fpptest/slow");
            return std::string(inEvent ? "early" : "waited");
        });
        add("Native Test In Callback", [this](const std::vector<std::string>&) {
            return std::string(inEvent ? "yes" : "no");
        });
#endif
#if defined(NATIVE_VARIABLES)
        Variables::INSTANCE.registerListener("fpptest", "Watched", [this](const std::string&, const std::string&) {
            inListener = true;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            inListener = false;
        });
        add("Native Test Unregister", [this](const std::vector<std::string>&) {
            Variables::INSTANCE.unregisterListener("fpptest", "Watched");
            return std::string(inListener ? "early" : "waited");
        });
        add("Native Test In Listener", [this](const std::vector<std::string>&) {
            return std::string(inListener ? "yes" : "no");
        });
#endif
    }
    virtual ~NativeTestPlugin() {
#if defined(NATIVE_TIMERS)
        for (auto& n : timerNames) {
            Timers::INSTANCE.stopPeriodicTimer(n);
        }
#endif
        for (auto* c : commands) {
            CommandManager::INSTANCE.removeCommand(c);
            delete c;
        }
    }

#if defined(NATIVE_THROW_MULTISYNC)
    virtual void multiSyncData(const uint8_t* data, int len) override {
        throw std::runtime_error("native test plugin: multiSyncData throws");
    }
#endif

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    std::vector<Command*> commands;
#if defined(NATIVE_TIMERS)
    struct PairState {
        std::atomic<bool> aStopped{ false };
        std::atomic<bool> bStopped{ false };
    };
    std::vector<PairState*> pairStates;
    std::vector<std::string> timerNames;
    int timerPairs = 0;
    std::atomic<int> late{ 0 };
#endif
#if defined(NATIVE_EVENTS)
    std::function<void(const std::string&, const std::string&)> eventCb;
    std::atomic<bool> inEvent{ false };
#endif
#if defined(NATIVE_VARIABLES)
    std::atomic<bool> inListener{ false };
#endif
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
#if defined(NATIVE_THROW_CREATE)
    const char* flag = getenv("NATIVE_THROW_FLAG");
    if (flag && access(flag, F_OK) == 0) {
        throw std::runtime_error("native test plugin: createPlugin throws");
    }
#endif
    return new NativeTestPlugin();
}
}
