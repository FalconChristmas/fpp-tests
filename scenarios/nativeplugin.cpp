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
//   NATIVE_SETTINGS        a 2 s listener on setting fpptestWatched; "Native
//                          Test Unregister Setting" likewise
//   NATIVE_SETVALUE        "Native Test Set Value <model> <value> <start> <end>"
//                          calls the model's protected setValue(), as a plugin
//                          subclass would
//   NATIVE_LEAKCHECK       "Native Test Leak Check" runs LeakSanitizer now
//                          (fppd _exit()s, so its check at exit never runs):
//                          "leaks" or "clean", the report going to log_path
//   NATIVE_GPIO            "Native Test GPIO <pin> <mode> [<0|1>]" configures
//                          the pin as an output in <mode> (gpio, gpio_od),
//                          sets it if a value is given and answers
//                          "acquired <0|1> value <getValue()>"
//   NATIVE_PLAYLIST_INSERTED  playlistInserted() appends "<playlist> <position>
//                          <endPosition> <immediate>" to $NATIVE_PLAYLIST_LOG
//   NATIVE_I2C             "Native Test I2C Raw <bus> <addr> <reg> <count>"
//                          writes <count> bytes (0x5A) to <reg> with
//                          I2CUtils::writeRawI2CBlockData() and answers what
//                          it returned

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
#if defined(NATIVE_SETTINGS)
#include "settings.h"
#endif
#if defined(NATIVE_SETVALUE)
#include "overlays/PixelOverlay.h"
#include "overlays/PixelOverlayModel.h"

// setValue() is protected, for subclasses: reach it the way one would.
struct SetValueAccess : public PixelOverlayModel {
    using PixelOverlayModel::setValue;
};
#endif

#if defined(NATIVE_I2C)
#include "util/I2CUtils.h"
#endif
#if defined(NATIVE_GPIO)
#include "util/GPIOUtils.h"
#endif

#if defined(NATIVE_LEAKCHECK)
// Weak, so the plugin still loads into an fppd without the ASan runtime.
extern "C" int __lsan_do_recoverable_leak_check() __attribute__((weak));
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

class NativeTestPlugin : public FPPPlugins::Plugin
#if defined(NATIVE_PLAYLIST_INSERTED)
    , public FPPPlugins::PlaylistEventPlugin
#endif
{
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
#if defined(NATIVE_SETTINGS)
        registerSettingsListener("fpptest", "fpptestWatched", [this](const std::string&) {
            inSettingListener = true;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            inSettingListener = false;
        });
        add("Native Test Unregister Setting", [this](const std::vector<std::string>&) {
            unregisterSettingsListener("fpptest", "fpptestWatched");
            return std::string(inSettingListener ? "early" : "waited");
        });
        add("Native Test In Setting Listener", [this](const std::vector<std::string>&) {
            return std::string(inSettingListener ? "yes" : "no");
        });
#endif
#if defined(NATIVE_SETVALUE)
        add("Native Test Set Value", [](const std::vector<std::string>& a) {
            if (a.size() < 4) {
                return std::string("usage: <model> <value> <start> <end>");
            }
            PixelOverlayModel* m = PixelOverlayManager::INSTANCE.getModel(a[0]);
            if (!m) {
                return std::string("no model ") + a[0];
            }
            (m->*(&SetValueAccess::setValue))((uint8_t)std::atoi(a[1].c_str()),
                                              std::atoi(a[2].c_str()), std::atoi(a[3].c_str()));
            return std::string("set");
        });
#endif
#if defined(NATIVE_GPIO)
        add("Native Test GPIO", [](const std::vector<std::string>& a) {
            if (a.size() < 2) {
                return std::string("usage: <pin> <mode> [<0|1>]");
            }
            const PinCapabilities& p = PinCapabilities::getPinByName(a[0]);
            if (!p.ptr()) {
                return std::string("no pin ") + a[0];
            }
            p.configPin(a[1], true, "Native");
            if (a.size() > 2 && !a[2].empty()) {
                p.setValue(a[2] == "1");
            }
            return std::string("acquired ") + (p.isAcquired() ? "1" : "0") + " value " +
                   (p.getValue() ? "1" : "0");
        });
#endif
#if defined(NATIVE_I2C)
        add("Native Test I2C Raw", [](const std::vector<std::string>& a) {
            if (a.size() < 4) {
                return std::string("usage: <bus> <addr> <reg> <count>");
            }
            I2CUtils i2c(std::atoi(a[0].c_str()), (int)std::strtol(a[1].c_str(), nullptr, 0), true);
            int count = std::atoi(a[3].c_str());
            std::vector<uint8_t> buf(count > 0 ? count : 0, 0x5A);
            return std::to_string(i2c.writeRawI2CBlockData((int)std::strtol(a[2].c_str(), nullptr, 0),
                                                           buf.data(), count));
        });
#endif
#if defined(NATIVE_LEAKCHECK)
        add("Native Test Leak Check", [](const std::vector<std::string>&) {
            if (!__lsan_do_recoverable_leak_check) {
                return std::string("no LeakSanitizer");
            }
            return std::string(__lsan_do_recoverable_leak_check() ? "leaks" : "clean");
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

#if defined(NATIVE_PLAYLIST_INSERTED)
    virtual void playlistInserted(const std::string& playlist, const int position, int endPosition, bool immediate) override {
        const char* path = std::getenv("NATIVE_PLAYLIST_LOG");
        if (path) {
            if (FILE* f = fopen(path, "a")) {
                fprintf(f, "%s %d %d %d\n", playlist.c_str(), position, endPosition, immediate ? 1 : 0);
                fclose(f);
            }
        }
    }
#endif
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
#if defined(NATIVE_SETTINGS)
    std::atomic<bool> inSettingListener{ false };
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
