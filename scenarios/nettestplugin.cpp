// A native (C++) plugin for test_network_clients.py, built by plugin_build.py
// against the tree under test: it drives fppd's network clients -- CurlManager,
// PingManager and controller detection -- the ways a plugin may, from threads
// of its own and from inside their callbacks.
//
//   "<PLUGIN_NAME> Curl Threads" <threads> <requests> <port>
//       <threads> threads at once, each making <requests> synchronous GETs
//       (CurlManager::doGet) of http://127.0.<thread>.<n>:<port>/ok -- a new
//       host every time.  Answers "<good>/<total>": how many came back as
//       status 200 with the body "ok".
//   "<PLUGIN_NAME> Ping Again" <dead host> <timeout ms> <live host> <file>
//       Pings <dead host>; when that times out, its callback pings <live
//       host>, and that ping's result (0 timed out, otherwise answered) is
//       written to <file>.
//   "<PLUGIN_NAME> Detect Throwing" <address>
//       Fetches the device's front page and starts controller detection on
//       it with a callback that throws once it has the result.

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "CurlManager.h"
#include "NetworkController.h"
#include "Plugin.h"
#include "commands/Commands.h"
#include "ping.h"

static int argInt(const std::vector<std::string>& args, size_t i, int dflt) {
    return args.size() > i ? std::atoi(args[i].c_str()) : dflt;
}

class CurlThreadsCommand : public Command {
public:
    CurlThreadsCommand() :
        Command(std::string(PLUGIN_NAME) + " Curl Threads") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        int threads = argInt(args, 0, 2);
        int requests = argInt(args, 1, 20);
        int port = argInt(args, 2, 80);
        std::atomic<int> good{ 0 };
        std::vector<std::thread> running;
        for (int t = 0; t < threads; t++) {
            running.emplace_back([t, requests, port, &good]() {
                for (int n = 0; n < requests; n++) {
                    std::string url = "http://127.0." + std::to_string(t + 1) + "." +
                                      std::to_string(n % 250 + 1) + ":" + std::to_string(port) + "/ok";
                    int rc = 0;
                    std::string body = CurlManager::INSTANCE.doGet(url, rc);
                    if (rc == 200 && body == "ok") {
                        good++;
                    }
                }
            });
        }
        for (auto& th : running) {
            th.join();
        }
        return std::make_unique<Command::Result>(std::to_string(good.load()) + "/" +
                                                 std::to_string(threads * requests));
    }
};

class PingAgainCommand : public Command {
public:
    PingAgainCommand() :
        Command(std::string(PLUGIN_NAME) + " Ping Again") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        if (args.size() < 4) {
            return std::make_unique<Command::ErrorResult>("needs <dead host> <timeout ms> <live host> <file>");
        }
        std::string live = args[2];
        std::string file = args[3];
        PingManager::INSTANCE.ping(args[0], argInt(args, 1, 100), [live, file](int r) {
            // On the ping thread, from the timeout sweep.
            PingManager::INSTANCE.ping(live, 2000, [file](int r2) {
                FILE* f = fopen(file.c_str(), "w");
                if (f) {
                    fprintf(f, "%d\n", r2);
                    fclose(f);
                }
            });
        });
        return std::make_unique<Command::Result>("sent");
    }
};

class DetectThrowingCommand : public Command {
public:
    DetectThrowingCommand() :
        Command(std::string(PLUGIN_NAME) + " Detect Throwing") {}
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& args) override {
        std::string ip = args.empty() ? std::string("127.0.0.1") : args[0];
        int rc = 0;
        std::string html = CurlManager::INSTANCE.doGet("http://" + ip + "/", rc);
        NetworkController::DetectControllerViaHTML(ip, html, [](NetworkController* nc) {
            bool found = nc != nullptr;
            delete nc;
            throw std::runtime_error(found ? "fpp-tests: detected, and threw" : "fpp-tests: nothing detected, and threw");
        });
        return std::make_unique<Command::Result>("started");
    }
};

class NetTestPlugin : public FPPPlugins::Plugin {
public:
    NetTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        CommandManager::INSTANCE.addCommand(&curlThreads);
        CommandManager::INSTANCE.addCommand(&pingAgain);
        CommandManager::INSTANCE.addCommand(&detectThrowing);
    }
    virtual ~NetTestPlugin() {
        CommandManager::INSTANCE.removeCommand(&curlThreads);
        CommandManager::INSTANCE.removeCommand(&pingAgain);
        CommandManager::INSTANCE.removeCommand(&detectThrowing);
    }
    CurlThreadsCommand curlThreads;
    PingAgainCommand pingAgain;
    DetectThrowingCommand detectThrowing;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new NetTestPlugin();
}
}
