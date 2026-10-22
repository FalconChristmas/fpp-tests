// A native plugin for test_schedule_threads.py: "Slow Test Command <path>
// <ms>" writes <path>.started, waits <ms>, then writes <path>, so a scenario
// can tell whether a command that was running when fppd stopped got to finish.
// Built against the tree under test the way native_plugin.py builds its own.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "Plugin.h"
#include "commands/Commands.h"

static void touch(const std::string& path) {
    if (FILE* f = fopen(path.c_str(), "w")) {
        fclose(f);
    }
}

class SlowCommand : public Command {
public:
    SlowCommand() :
        Command("Slow Test Command") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        if (args.size() < 2) {
            return std::make_unique<Command::ErrorResult>("usage: <path> <ms>");
        }
        touch(args[0] + ".started");
        std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(args[1].c_str())));
        touch(args[0]);
        return std::make_unique<Command::Result>("done");
    }
};

class SlowCommandPlugin : public FPPPlugins::Plugin {
public:
    SlowCommandPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        CommandManager::INSTANCE.addCommand(command);
    }
    virtual ~SlowCommandPlugin() {
        CommandManager::INSTANCE.removeCommand(command);
        delete command;
    }

private:
    SlowCommand* command = new SlowCommand();
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SlowCommandPlugin();
}
}
