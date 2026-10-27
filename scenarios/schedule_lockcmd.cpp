// A native plugin for test_schedule_threads.py: "Slow Schedule Read <path>
// <ms>" writes <path>.started, waits <ms>, reads the schedule (which takes the
// scheduler's lock), then writes <path>. Run as a playlist's first entry it
// holds the playlist lock across the wait, so a scenario can line the
// scheduler up against a playlist that is starting.
// Built against the tree under test the way native_plugin.py builds its own.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "Plugin.h"
#include "Scheduler.h"
#include "commands/Commands.h"

static void touch(const std::string& path) {
    if (FILE* f = fopen(path.c_str(), "w")) {
        fclose(f);
    }
}

class SlowScheduleRead : public Command {
public:
    SlowScheduleRead() :
        Command("Slow Schedule Read") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        if (args.size() < 2) {
            return std::make_unique<Command::ErrorResult>("usage: <path> <ms>");
        }
        touch(args[0] + ".started");
        std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(args[1].c_str())));
        scheduler->GetSchedule();
        touch(args[0]);
        return std::make_unique<Command::Result>("done");
    }
};

class SlowScheduleReadPlugin : public FPPPlugins::Plugin {
public:
    SlowScheduleReadPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        CommandManager::INSTANCE.addCommand(command);
    }
    virtual ~SlowScheduleReadPlugin() {
        CommandManager::INSTANCE.removeCommand(command);
        delete command;
    }

private:
    SlowScheduleRead* command = new SlowScheduleRead();
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SlowScheduleReadPlugin();
}
}
