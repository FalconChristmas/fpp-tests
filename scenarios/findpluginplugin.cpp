// A native (C++) plugin for test_plugin_shlib_in_fppd_dir.py, built by
// plugin_build.py against the tree under test.  "<PLUGIN_NAME> Find <name>"
// asks the plugin manager for the plugin <name> the way code that is not
// the plugin manager does (findPlugin(), which looks for lib<name>.so by
// its bare name) and answers whether it got one.

#include <memory>
#include <string>
#include <vector>

#include "Plugin.h"
#include "Plugins.h"
#include "commands/Commands.h"
#include "common_mini.h"

class FindCommand : public Command {
public:
    FindCommand() :
        Command(std::string(PLUGIN_NAME) + " Find") {
        args.push_back(CommandArg("name", "string", "Plugin"));
    }
    std::unique_ptr<Command::Result> run(const std::vector<std::string>& a) override {
        FPPPlugins::Plugin* p = a.empty() ? nullptr : PluginManager::INSTANCE.findPlugin(a[0]);
        return std::make_unique<Command::Result>(p ? "found" : "not found");
    }
};

class FindPlugin : public FPPPlugins::Plugin {
public:
    FindPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        cmd = new FindCommand();
        CommandManager::INSTANCE.addCommand(cmd);
    }
    virtual ~FindPlugin() {}
    Command* cmd = nullptr;
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new FindPlugin();
}
}
