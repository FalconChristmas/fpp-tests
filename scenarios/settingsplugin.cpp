// A native (C++) plugin that watches its own settings file
// (FPPPlugins::Plugin's monitorSettings) for test_plugin_settings_reload.py,
// built by plugin_build.py against the tree under test.
//
// Each instance takes the next generation number. settingChanged() records
// "<generation>:<key>=<value>" in a log kept in the library, which outlives
// the instances: the plugin does not declare FPP_PLUGIN_SUPPORTS_UNLOAD, so
// an unload leaves it mapped and a reload gets the same statics.
// "<PLUGIN_NAME> Seen" answers the log, one entry per line.
//
// shutdown() asks for $SP_SETTLE_MS (default 4000) of settling time, so the
// unloaded instance waits that long to be deleted -- the window in which a
// reload constructs the new instance beside it.

#include <cstdlib>
#include <mutex>
#include <string>
#include <vector>

#include "Plugin.h"
#include "common.h"
#include "commands/Commands.h"

static std::mutex logLock;
static std::string seenLog;
static int generations = 0;

class SeenCommand : public Command {
public:
    SeenCommand() :
        Command(std::string(PLUGIN_NAME) + " Seen") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        std::lock_guard<std::mutex> l(logLock);
        return std::make_unique<Command::Result>(seenLog);
    }
};

class SettingsPlugin : public FPPPlugins::Plugin {
public:
    SettingsPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME, true) {
        {
            std::lock_guard<std::mutex> l(logLock);
            generation = ++generations;
        }
        seen = new SeenCommand();
        CommandManager::INSTANCE.addCommand(seen);
    }
    virtual ~SettingsPlugin() {
        withdraw();
    }

    void settingChanged(const std::string& key, const std::string& value) override {
        std::lock_guard<std::mutex> l(logLock);
        seenLog += std::to_string(generation) + ":" + key + "=" + value + "\n";
    }

    std::function<bool()> shutdown() override {
        withdraw();
        const char* s = getenv("SP_SETTLE_MS");
        long long until = GetTimeMS() + (s ? atoi(s) : 4000);
        return [until]() { return GetTimeMS() >= until; };
    }

private:
    void withdraw() {
        if (seen) {
            CommandManager::INSTANCE.removeCommand(seen);
            delete seen;
            seen = nullptr;
        }
    }
    int generation = 0;
    Command* seen = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SettingsPlugin();
}
}
