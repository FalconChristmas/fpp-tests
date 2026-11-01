// A native (C++) plugin for test_playlist_plugin_reader.py, built by
// plugin_build.py against the tree under test: a thread of its own that asks
// the Player about the current playlist in a loop, the way a plugin's status
// or display thread does, with no lock or log call of its own between reads
// -- so under TSan nothing but the Player's own synchronization orders them
// against the main loop.
//
// $PR_READ picks what each pass reads:
//   status  Player::GetStatus() and IsPlaying() (the playlist's status flag)
//   name    Player::GetPlaylistName()
//   pos     Playlist::GetCurrentPosInMS(pos, posms), as a timecode plugin
//           (ArtNet, SMPTE) does each frame
//
// "<PLUGIN_NAME> Reads" answers how many passes the thread has made.

#include <atomic>
#include <cstdlib>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "Player.h"
#include "Plugin.h"
#include "playlist/Playlist.h"
#include "commands/Commands.h"

class ReadsCommand : public Command {
public:
    ReadsCommand(std::atomic<long>& r) :
        Command(std::string(PLUGIN_NAME) + " Reads"), reads(r) {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        return std::make_unique<Command::Result>(std::to_string(reads.load()));
    }
    std::atomic<long>& reads;
};

class PlayerReaderPlugin : public FPPPlugins::Plugin {
public:
    PlayerReaderPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        const char* r = getenv("PR_READ");
        std::string what = r ? r : "status";
        cmd = new ReadsCommand(reads);
        CommandManager::INSTANCE.addCommand(cmd);
        thread = std::thread([this, what]() {
            volatile long sink = 0;
            while (!stop) {
                if (what == "name") {
                    sink += Player::INSTANCE.GetPlaylistName().size();
                } else if (what == "pos") {
                    int pos = 0;
                    uint64_t posms = 0;
                    sink += Player::INSTANCE.PlaylistSnapshot()->GetCurrentPosInMS(pos, posms) + pos + posms;
                } else {
                    sink += (int)Player::INSTANCE.GetStatus() + Player::INSTANCE.IsPlaying();
                }
                reads++;
                usleep(200);
            }
        });
    }
    virtual ~PlayerReaderPlugin() {
        halt();
    }
#if FPP_PLUGIN_API_VERSION >= 6
    std::function<bool()> shutdown() override {
        halt();
        return nullptr;
    }
#endif

private:
    void halt() {
        stop = true;
        if (thread.joinable()) {
            thread.join();
        }
        if (cmd) {
            CommandManager::INSTANCE.removeCommand(cmd);
            delete cmd;
            cmd = nullptr;
        }
    }
    std::atomic<bool> stop{ false };
    std::atomic<long> reads{ 0 };
    std::thread thread;
    Command* cmd = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new PlayerReaderPlugin();
}
}
