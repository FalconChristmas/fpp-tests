// A native (C++) plugin for test_playlist_positions.py, built by
// plugin_build.py against the tree under test: what a timecode plugin does
// with a playlist's per-entry positions. Commands, each prefixed with
// PLUGIN_NAME and answering a string:
//
//   Load <playlist>      Player::Load() -- "ok"
//   FindPos <ms>         Player::FindPosForMS() -- "<position> <ms left in it>"
//   Files <pos>          Player::GetFilenamesForPos() -- "<sequence>|<media>"
//   Current              Playlist::GetCurrentPosInMS(pos, posms) --
//                        "<ms into the playlist> <position> <ms into it>"
//   Sync <ms> <pos> <playlist>
//                        MultiSync::SyncPlaylistToMS(); a pos of "none"
//                        calls the overload without one -- "ok"

#include <cstdlib>
#include <string>
#include <vector>

#include "MultiSync.h"
#include "Plugin.h"
#include "Player.h"
#include "commands/Commands.h"
#include "playlist/Playlist.h"

class FnCommand : public Command {
public:
    FnCommand(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) :
        Command(std::string(PLUGIN_NAME) + " " + n), fn(f) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& a) override {
        return std::make_unique<Command::Result>(fn(a));
    }
    std::function<std::string(const std::vector<std::string>&)> fn;
};

class PlaylistPosPlugin : public FPPPlugins::Plugin {
public:
    PlaylistPosPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        add("Load", [](const std::vector<std::string>& a) {
            Player::INSTANCE.Load(a.empty() ? "" : a[0]);
            return std::string("ok");
        });
        add("FindPos", [](const std::vector<std::string>& a) {
            uint64_t ms = a.empty() ? 0 : strtoull(a[0].c_str(), nullptr, 10);
            int pos = Player::INSTANCE.FindPosForMS(ms, false);
            return std::to_string(pos) + " " + std::to_string(ms);
        });
        add("Files", [](const std::vector<std::string>& a) {
            std::string seq, med;
            Player::INSTANCE.GetFilenamesForPos(a.empty() ? 0 : atoi(a[0].c_str()), seq, med);
            return seq + "|" + med;
        });
        add("Current", [](const std::vector<std::string>&) {
            int pos = 0;
            uint64_t posms = 0;
            uint64_t ms = Player::INSTANCE.PlaylistSnapshot()->GetCurrentPosInMS(pos, posms);
            return std::to_string(ms) + " " + std::to_string(pos) + " " + std::to_string(posms);
        });
        add("Sync", [](const std::vector<std::string>& a) {
            if (a.size() < 3) {
                return std::string("ms, pos and playlist needed");
            }
            uint64_t ms = strtoull(a[0].c_str(), nullptr, 10);
            if (a[1] == "none") {
                multiSync->SyncPlaylistToMS(ms, a[2], false);
            } else {
                multiSync->SyncPlaylistToMS(ms, atoi(a[1].c_str()), a[2], false);
            }
            return std::string("ok");
        });
    }
    virtual ~PlaylistPosPlugin() {
        withdraw();
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        withdraw();
        return nullptr;
    }
#endif

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    void withdraw() {
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
    return new PlaylistPosPlugin();
}
}
