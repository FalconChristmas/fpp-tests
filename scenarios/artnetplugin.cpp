// A native (C++) plugin that speaks ArtNet, for test_artnet_port.py: it adds
// an opcode handler for ArtTrigger (0x9900) with AddArtNetOpcodeHandler(), the
// way a plugin adding ArtNet trigger support does, and gives it back with
// RemoveArtNetOpcodeHandler() when it is unloaded. Each ArtTrigger it is
// handed is logged as "artnet plugin <name> trigger key <k> subkey <s>" at
// warning level on VB_PLUGIN. Built by native_plugin.install(source=...).

#include <cstdint>
#include <functional>

#include "Plugin.h"
#include "e131bridge.h"
#include "log.h"

#ifdef FPP_PLUGIN_SUPPORTS_UNLOAD
FPP_PLUGIN_SUPPORTS_UNLOAD()
#endif

static constexpr int OP_TRIGGER = 0x9900;

class ArtNetTestPlugin : public FPPPlugins::Plugin {
public:
    ArtNetTestPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {
        AddArtNetOpcodeHandler(OP_TRIGGER, [](uint8_t* data, long long) {
            // ArtTrigger: ID, opcode, version, filler 1-2, OemCode (2), Key, SubKey
            LogWarn(VB_PLUGIN, "artnet plugin %s trigger key %d subkey %d\n", PLUGIN_NAME, data[16], data[17]);
            return true;
        });
        LogWarn(VB_PLUGIN, "artnet plugin %s loaded\n", PLUGIN_NAME);
    }
    virtual ~ArtNetTestPlugin() {
        RemoveArtNetOpcodeHandler(OP_TRIGGER);
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new ArtNetTestPlugin();
}
}
