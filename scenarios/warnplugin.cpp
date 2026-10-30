// A native (C++) test plugin that raises and clears fppd warnings the way a
// plugin does, built by test_plugin_warnings.py against the tree under test.
//
//   "Warning Test Add <id> <message> [plugin]"     WarningHolder::AddWarningTimeout
//                                                  with no timeout, under that plugin name
//   "Warning Test Remove <id> <message> [plugin]"  WarningHolder::RemoveWarning

#include <cstdlib>
#include <map>
#include <string>
#include <vector>

#include "Plugin.h"
#include "Warnings.h"
#include "commands/Commands.h"

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

class WarningTestPlugin : public FPPPlugins::Plugin {
public:
    WarningTestPlugin() :
        FPPPlugins::Plugin("fpp-warntest") {
        add("Warning Test Add", [](const std::vector<std::string>& a) {
            if (a.size() < 2) {
                return std::string("usage: id message [plugin]");
            }
            WarningHolder::AddWarningTimeout(-1, std::atoi(a[0].c_str()), a[1], {}, a.size() > 2 ? a[2] : "");
            return std::string("added");
        });
        add("Warning Test Remove", [](const std::vector<std::string>& a) {
            if (a.size() < 2) {
                return std::string("usage: id message [plugin]");
            }
            WarningHolder::RemoveWarning(std::atoi(a[0].c_str()), a[1], a.size() > 2 ? a[2] : "");
            return std::string("removed");
        });
    }
    virtual ~WarningTestPlugin() {
        for (auto* c : commands) {
            CommandManager::INSTANCE.removeCommand(c);
            delete c;
        }
    }

private:
    void add(const std::string& n, std::function<std::string(const std::vector<std::string>&)> f) {
        auto* c = new FnCommand(n, f);
        commands.push_back(c);
        CommandManager::INSTANCE.addCommand(c);
    }
    std::vector<Command*> commands;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new WarningTestPlugin();
}
}
