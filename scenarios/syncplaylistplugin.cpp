// A native (C++) plugin for test_playlist_sync_load.py, built by
// plugin_build.py against the tree under test. It registers one command,
// "<PLUGIN_NAME> Sync <ms> <pos> <playlist>", which calls
// MultiSync::SyncPlaylistToMS() -- the public call that moves the player to
// a playlist and position, loading the playlist first if it is not the one
// in the player -- and answers "ok" once it returns.

#include <cstdlib>
#include <string>
#include <vector>

#include "MultiSync.h"
#include "Plugin.h"
#include "commands/Commands.h"

class SyncCommand : public Command {
public:
    SyncCommand() :
        Command(std::string(PLUGIN_NAME) + " Sync") {
        args.push_back(CommandArg("ms", "int", "ms"));
        args.push_back(CommandArg("pos", "int", "pos"));
        args.push_back(CommandArg("playlist", "string", "playlist"));
    }
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& a) override {
        if (a.size() < 3) {
            return std::make_unique<Command::ErrorResult>("ms, pos and playlist needed");
        }
        multiSync->SyncPlaylistToMS(atoll(a[0].c_str()), atoi(a[1].c_str()), a[2], false);
        return std::make_unique<Command::Result>("ok");
    }
};

class SyncPlaylistPlugin : public FPPPlugins::Plugin {
public:
    SyncPlaylistPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        cmd = new SyncCommand();
        CommandManager::INSTANCE.addCommand(cmd);
    }
    virtual ~SyncPlaylistPlugin() {
        withdraw();
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        withdraw();
        return nullptr;
    }
#endif

private:
    void withdraw() {
        if (cmd) {
            CommandManager::INSTANCE.removeCommand(cmd);
            delete cmd;
            cmd = nullptr;
        }
    }
    Command* cmd = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new SyncPlaylistPlugin();
}
}
